/**
 * End-to-end smoke test for the Altien skills importer, against the REAL
 * local stack: real Postgres, real blob storage, real SQL constraints.
 *
 *   npm run smoke:skills --prefix backend
 *
 * Only the model is stubbed. Everything the unit suites fake — migrations,
 * foreign keys, blob round-trips, the runtime prompt — is exercised for real,
 * which is precisely the layer where this feature kept breaking while 711
 * mocked tests stayed green.
 *
 * It writes to the configured database and cleans up after itself. Point it
 * at a development database, never a shared one.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { createServerSupabase } from "../lib/supabase";
import { validateSkillZip } from "../altien/skills/archive";
import {
  deleteSkillDraftVersion,
  storeSkillSnapshot,
} from "../altien/skills/persistence";
import { analyseSkillVersion, createSkillRun, postSkillReviewMessage } from "../altien/skills/review";
import { loadSkillChatRuntimeContext } from "../altien/skills/runtime";
import { SKILL_RESOURCE_TOOL_NAMES } from "../altien/skills/resources";
import { checkSchemaVersion } from "../lib/schemaCheck";

const FIXTURES = join(process.cwd(), "..", "tools", "skill-fixtures", "out");
const db = createServerSupabase();

let failures = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * A private copy of the case-summariser fixture under a unique name. Importing
 * the fixture itself would collide with a real library entry on content hash —
 * correctly, since identical content is the same version — and would also risk
 * this script deleting a skill somebody was using.
 */
async function buildSmokePackage(canonicalName: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    `${canonicalName}/SKILL.md`,
    `---
name: ${canonicalName}
description: Smoke-test copy of the case summariser; safe to delete.
version: 1.0.0
---

# Smoke Case Summariser

1. Read the project documents you have been given.
2. Load \`reference/house-format.md\` with the skill resource tools first.
3. Produce Parties, Issues, Holding, Key dates.
`,
  );
  zip.file(
    `${canonicalName}/reference/house-format.md`,
    "# House summary format\n\nParties, Issues, Holding, Key dates.\n\nMARKER-HOUSE-FORMAT-9F2A\n",
  );
  zip.file(
    `${canonicalName}/reference/citation-style.md`,
    "# Citation style\nCite as (Document name, p.N).\nMARKER-CITATION-STYLE-4B7C\n",
  );
  zip.file(`${canonicalName}/LICENSE`, "MIT License\n");
  return new Uint8Array(
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
}

/**
 * The shape kimi-k3 really produced for this package, including its habit of
 * labelling package reading `kind: "skill"`. Stubbed so the run is
 * deterministic and costs nothing, but not simplified: a friendlier analysis
 * would stop this proving what it is here to prove.
 */
const STUB_ANALYSIS = {
  provider: "stub",
  model: "stub-analysis",
  schemaVersion: 1,
  inputHash: "smoke-input-hash",
  generated: {
    summary: "Summarises a litigation document using a bundled house format.",
    risks: [],
    unresolvedReferences: [
      "reference/house-format.md",
      "skill resource tools (no matching tool schema provided)",
    ],
    capabilityRequirements: [
      {
        name: "project document reading",
        kind: "project_read",
        required: true,
        rationale: "Reads the project documents.",
      },
      {
        name: "skill resource loading tools for reference/house-format.md",
        kind: "skill",
        required: true,
        rationale: "Loads the house format before writing.",
      },
    ],
  },
};

const STUB_SETTINGS = async () =>
  ({
    fast_model: "stub-analysis",
    tabular_model: "stub-analysis",
    legal_research_us: false,
    api_keys: {},
  }) as never;

async function firstRow<T>(table: string, columns: string, filters: [string, unknown][] = []) {
  let query = db.from(table).select(columns).limit(1);
  for (const [column, value] of filters) query = query.eq(column, value);
  const result = await query;
  if (result.error) throw new Error(`${table}: ${result.error.message}`);
  return (result.data?.[0] ?? null) as T | null;
}

async function main() {
  console.log("\nSkills importer smoke test (real database, stubbed model)\n");

  console.log("Schema");
  const schema = await checkSchemaVersion({ db, log: () => {} });
  check("every migration in this build is applied", schema.pending.length === 0, schema.pending);
  if (schema.pending.length) {
    console.log("\n  Run: npm run migrate:local --prefix backend\n");
    process.exit(1);
  }

  console.log("\nArchive validation");
  const rejections: Array<[string, string]> = [
    ["f4-reject-traversal.zip", "unsafe_path"],
    ["f5-reject-secret.zip", "credential_detected"],
    ["f6-reject-no-entrypoint.zip", "skill_missing"],
    ["f7-reject-zip-bomb.zip", "file_size_limit"],
    ["f8-reject-encrypted.zip", "encrypted_archive"],
  ];
  for (const [name, expected] of rejections) {
    let code = "<accepted>";
    try {
      await validateSkillZip(fixture(name));
    } catch (error) {
      code = String((error as { code?: string }).code ?? "<no code>");
    }
    check(`${name} rejected as ${expected}`, code === expected, code);
  }

  const owner = await firstRow<{ user_id: string }>("user_profiles", "user_id");
  const project = await firstRow<{ id: string; user_id: string }>("projects", "id, user_id");
  if (!owner || !project) {
    console.log("\n  SKIP  no user profile or project in this database; import lifecycle not run\n");
    process.exit(failures ? 1 : 0);
  }
  // A real tenant row: several skill tables carry a tenant_id foreign key.
  // Skill tables reference tenants(tenant_id), which is a different column
  // from tenants(id) — picking the wrong one is what failed this script first.
  const tenant = await firstRow<{ tenant_id: string }>("tenants", "tenant_id");
  if (!tenant) {
    console.log("\n  SKIP  no tenant in this database; import lifecycle not run\n");
    process.exit(failures ? 1 : 0);
  }
  const tenantId = tenant.tenant_id;

  let versionId = "";
  try {
    console.log("\nImport");
    const canonicalName = `smoke-case-summariser-${randomUUID().slice(0, 8)}`;
    const packageBytes = await buildSmokePackage(canonicalName);
    const snapshot = await validateSkillZip(packageBytes);
    check("the smoke package validates", snapshot.skills.length === 1);
    const stored = await storeSkillSnapshot({
      tenantId,
      importedBy: owner.user_id,
      sourceFilename: `${canonicalName}.zip`,
      sourceBytes: packageBytes,
      snapshot,
    });
    versionId = String(stored.skills[0]?.version?.id ?? "");
    check("import persisted a draft version", !!versionId);
    if (!versionId) throw new Error("no version id");

    console.log("\nAnalysis");
    await analyseSkillVersion({
      tenantId,
      versionId,
      userId: owner.user_id,
      db,
      analyse: async () => STUB_ANALYSIS as never,
      settings: STUB_SETTINGS as never,
    });
    const analysed = await firstRow<{ analysis_state: string }>(
      "altien_skill_versions",
      "analysis_state",
      [["id", versionId]],
    );
    check("analysis recorded as succeeded", analysed?.analysis_state === "succeeded", analysed);

    console.log("\nReview and enablement");
    const proposed = await postSkillReviewMessage({
      tenantId,
      versionId,
      userId: owner.user_id,
      message: "enable",
      db,
      settings: STUB_SETTINGS as never,
    });
    // Unresolved references and a package-read requirement labelled "skill"
    // both used to end the lifecycle here with no way forward.
    check("enable was proposed, not blocked", proposed.outcome === "proposed", proposed.outcome);
    check(
      "the proposal carries a payload hash",
      !!("action" in proposed && proposed.action?.payloadHash),
    );

    const approved = await postSkillReviewMessage({
      tenantId,
      versionId,
      userId: owner.user_id,
      message: "yes",
      db,
      settings: STUB_SETTINGS as never,
    });
    check("approval enabled the version", approved.outcome === "enabled", approved.outcome);

    console.log("\nRun and runtime binding");
    const run = await createSkillRun({
      tenantId,
      versionId,
      projectId: project.id,
      userId: project.user_id,
      db,
    });
    check("a bound chat was created", !!run.chatId);

    const runtime = await loadSkillChatRuntimeContext({
      chatId: run.chatId,
      projectId: project.id,
      tenantId,
      db,
    });
    check("the chat resolves a skill runtime", !!runtime);
    check(
      "the prompt names the skill and its exact version",
      !!runtime &&
        runtime.systemPrompt.includes(runtime.displayName) &&
        runtime.systemPrompt.includes(runtime.versionId),
    );
    check(
      "the prompt carries the root instructions",
      !!runtime && runtime.systemPrompt.includes("ROOT_SKILL_INSTRUCTIONS"),
    );
    for (const tool of Object.values(SKILL_RESOURCE_TOOL_NAMES)) {
      check(`${tool} is granted to the run`, !!runtime?.allowedToolNames.includes(tool));
    }

    console.log("\nResource tools (blob round-trip)");
    const listed = runtime ? runtime.resourceStore.list() : [];
    const houseFormat = listed.find((entry) => entry.path.endsWith("reference/house-format.md"));
    check("list_skill_resources sees the reference file", !!houseFormat, listed.map((e) => e.path));
    if (houseFormat && runtime) {
      const read = await runtime.resourceStore.read({ path: houseFormat.path });
      // The marker exists only inside the stored blob — never in the prompt —
      // so finding it proves the whole storage path, not a cached manifest.
      check(
        "read_skill_resource returns the file's real content",
        read.text.includes("MARKER-HOUSE-FORMAT-9F2A"),
        read.text.slice(0, 80),
      );
      const found = await runtime.resourceStore.search({ query: "MARKER-CITATION-STYLE" });
      check("search_skill_resources finds a second file", found.matches.length > 0);
    }
  } finally {
    if (versionId) {
      console.log("\nCleanup");
      try {
        // Enabled versions are undeletable by design, so drop it back to a
        // draft first — the same rule the endpoint enforces for a member.
        await db
          .from("altien_skill_versions")
          .update({ state: "draft" })
          .eq("id", versionId);
        await db.from("altien_chat_skill_bindings").delete().eq("root_version_id", versionId);
        const removed = await deleteSkillDraftVersion({ tenantId, versionId, db });
        check("the draft and everything it created were removed", !!removed.versionId);
      } catch (error) {
        failures += 1;
        console.log(`  FAIL  cleanup: ${(error as Error).message}`);
        console.log(`        leftover version ${versionId}`);
      }
    }
  }

  console.log(
    failures ? `\n${failures} check(s) failed\n` : "\nAll checks passed\n",
  );
  process.exit(failures ? 1 : 0);
}

void main().catch((error) => {
  console.error("\nsmoke test crashed:", error);
  process.exit(1);
});
