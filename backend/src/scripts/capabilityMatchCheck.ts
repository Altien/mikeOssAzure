/**
 * What the capability matcher actually decides, against the real catalogue and
 * the configured model.
 *
 *   npm run check:matching --prefix backend
 *
 * Every unit test around this stubs the model, so they prove the loop and the
 * aggregation but say nothing about the judgement — and the judgement is where
 * this feature keeps going wrong: a bundled script answered with read_document
 * rather than the verification-grade extractor, or a requirement blocked
 * because of the words a re-analysis happened to choose.
 *
 * Reads stored analyses and writes nothing. Swap the configured fast model and
 * run it again to compare one model's choices against another's.
 */
import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import {
  firstPartyToolCatalogue,
  inspectMcpToolCatalogue,
  resolveCapabilityContractWithLlm,
} from "../altien/skills/capabilities";
import { skillAnalysisModel } from "../altien/skills/settings";
import { getUserModelSettings } from "../lib/userSettings";

const db = createServerSupabase();

async function main() {
  const versions = await db
    .from("altien_skill_versions")
    .select("id, state, generated_analysis");
  if (versions.error) throw new Error(versions.error.message);

  const connectors = await db
    .from("user_mcp_connectors")
    .select("user_id, name, enabled");
  if (connectors.error) throw new Error(connectors.error.message);
  const userId = String(connectors.data?.[0]?.user_id ?? "");

  const settings = await getUserModelSettings(userId, db as never);
  const model = skillAnalysisModel(settings.fast_model);
  const catalogue = [
    ...firstPartyToolCatalogue(),
    ...(await inspectMcpToolCatalogue(userId, db)),
  ];
  console.log(`model: ${model}   catalogue: ${catalogue.length}\n`);

  for (const row of versions.data ?? []) {
    const analysis = row.generated_analysis as {
      capabilityRequirements?: unknown[];
    } | null;
    if (!analysis?.capabilityRequirements?.length) continue;
    console.log("=".repeat(78));
    console.log(`version ${row.id} (${row.state})`);
    const contract = await resolveCapabilityContractWithLlm({
      analysis: analysis as never,
      catalogue,
      model,
      apiKeys: settings.api_keys,
    });
    const label = (name: string) => contract.toolLabels?.[name] ?? name;
    for (const mapping of contract.mappings) {
      const req = mapping.requirement as { name: string; required: boolean };
      const tools = (mapping.mappedToolNames ?? []).map(label);
      console.log(
        `  [${mapping.status}]${req.required ? "" : " (optional)"} ${req.name}`,
      );
      if (tools.length) console.log(`      -> ${tools.join(", ")}`);
      const atoms = (mapping as { atoms?: Array<Record<string, unknown>> })
        .atoms;
      for (const atom of atoms ?? []) {
        const names = ((atom.mappedToolNames as string[]) ?? []).map(label);
        console.log(
          `      · ${atom.label} -> ${names.length ? names.join(", ") : "(none)"}`,
        );
      }
    }
    console.log(
      `\n  BLOCKERS: ${contract.blockers.length ? contract.blockers.map((b) => b.requirement.name).join(" | ") : "none"}`,
    );
  }
}

void main();
