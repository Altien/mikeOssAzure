// Altien's deployment-owned catalog is copied through the normal Skills
// import/review pipeline. Tenant input selects an ID, never a repository/ref.
import { getConfig, getKeyVaultConfig } from "../../lib/config";
import { acquireGitHubSkill, parseGitHubSourceUrl } from "./github";
import { storeSkillSnapshot } from "./persistence";

export type SkillCatalogItem = { id: string; displayName: string; description: string; commit: string };
type CatalogSource = SkillCatalogItem & { url: string; repository: string; selectedPath: string };

export class SkillCatalogError extends Error {
  constructor(readonly status: 404 | 502 | 503, message: string) { super(message); }
}

export function parseSkillCatalog(raw: string): CatalogSource[] {
  let value: unknown;
  try { value = JSON.parse(raw || "[]"); }
  catch { throw new SkillCatalogError(503, "The Altien catalog is unavailable."); }
  if (!Array.isArray(value) || value.length > 100) throw new SkillCatalogError(503, "The Altien catalog is unavailable.");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)
      || ids.has(item.id) || typeof item.displayName !== "string" || !item.displayName.trim() || item.displayName.length > 128
      || typeof item.description !== "string" || item.description.length > 2000 || typeof item.url !== "string" || item.url.length > 2000) {
      throw new SkillCatalogError(503, "The Altien catalog is unavailable.");
    }
    if (/\/\.{1,2}(?:\/|$)|%2e/i.test(item.url)) throw new SkillCatalogError(503, "The Altien catalog is unavailable.");
    ids.add(item.id);
    let source: ReturnType<typeof parseGitHubSourceUrl>;
    try { source = parseGitHubSourceUrl(item.url); }
    catch { throw new SkillCatalogError(503, "The Altien catalog is unavailable."); }
    const [commit, ...path] = source.treeTail;
    if (!commit || !/^[0-9a-f]{40}$/i.test(commit) || path.some((part) => !part || [".", ".."].includes(part) || /[%\\]/.test(part))) {
      throw new SkillCatalogError(503, "The Altien catalog is unavailable.");
    }
    return { id: item.id, displayName: item.displayName.trim(), description: item.description, url: item.url,
      commit: commit.toLowerCase(), repository: "github.com/" + source.owner + "/" + source.repository, selectedPath: path.join("/") };
  });
}

async function catalogSources(): Promise<CatalogSource[]> {
  // Deliberately getConfig, not tenant config: tenant settings cannot publish
  // or replace Altien-curated entries. No browser runtime config is involved.
  let raw = "";
  try { raw = await getConfig("altien-skill-catalog"); }
  catch (error) {
    const missing = error as { statusCode?: number; code?: string };
    if (process.env.KEY_VAULT_NAME && missing.statusCode !== 404 && missing.code !== "SecretNotFound") throw error;
  }
  return parseSkillCatalog(raw);
}

export async function listSkillCatalog(): Promise<SkillCatalogItem[]> {
  return (await catalogSources()).map(({ id, displayName, description, commit }) => ({ id, displayName, description, commit }));
}

export async function importCatalogSkill(args: { catalogId: string; tenantId: string; importedBy: string }) {
  const entry = (await catalogSources()).find((item) => item.id === args.catalogId);
  if (!entry) throw new SkillCatalogError(404, "Catalog skill not found.");
  // The curated source may be available independently of arbitrary GitHub
  // imports. Only the deployment's read credential can fetch a private source.
  const vaultToken = process.env.KEY_VAULT_NAME
    ? (await getKeyVaultConfig("altien-skill-catalog-github-token").catch(() => "")).trim() : "";
  const envToken = (process.env.ALTIEN_SKILL_CATALOG_GITHUB_TOKEN ?? "").trim();
  const token = vaultToken && vaultToken !== "__unset__" ? vaultToken : envToken === "__unset__" ? "" : envToken;
  const acquired = await acquireGitHubSkill({ url: entry.url, token: token || undefined });
  if (acquired.provenance.resolvedCommitSha.toLowerCase() !== entry.commit
    || acquired.provenance.repository.toLowerCase() !== entry.repository.toLowerCase()
    || acquired.provenance.selectedPath !== entry.selectedPath) {
    throw new SkillCatalogError(502, "The catalog skill could not be verified. Try again later.");
  }
  return storeSkillSnapshot({ tenantId: args.tenantId, importedBy: args.importedBy,
    sourceFilename: entry.id + "-" + entry.commit.slice(0, 12) + ".zip",
    sourceBytes: acquired.sourceBytes, snapshot: acquired.snapshot, sourceKind: "github", github: acquired.provenance,
    catalog: { id: entry.id, displayName: entry.displayName, commit: entry.commit } });
}
