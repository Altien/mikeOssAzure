import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { getConfigMock, getKeyVaultConfigMock, acquireMock, storeMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(), getKeyVaultConfigMock: vi.fn(), acquireMock: vi.fn(), storeMock: vi.fn(),
}));
vi.mock("../../lib/config", () => ({ getConfig: getConfigMock, getKeyVaultConfig: getKeyVaultConfigMock }));
vi.mock("./github", async (original) => ({ ...(await original<typeof import("./github")>()), acquireGitHubSkill: acquireMock }));
vi.mock("./persistence", () => ({ storeSkillSnapshot: storeMock }));
import { importCatalogSkill, listSkillCatalog, parseSkillCatalog } from "./catalog";
const commit = "a".repeat(40);
const source = { id: "contract-review", displayName: "Contract review", description: "Review a contract.", url: "https://github.com/example/skills/tree/" + commit + "/review" };
const env = { KEY_VAULT_NAME: process.env.KEY_VAULT_NAME, ALTIEN_SKILL_CATALOG_GITHUB_TOKEN: process.env.ALTIEN_SKILL_CATALOG_GITHUB_TOKEN };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KEY_VAULT_NAME; delete process.env.ALTIEN_SKILL_CATALOG_GITHUB_TOKEN;
  getConfigMock.mockResolvedValue(JSON.stringify([source]));
  getKeyVaultConfigMock.mockResolvedValue("");
  acquireMock.mockResolvedValue({ sourceBytes: new Uint8Array([1]), snapshot: { treeHash: "tree" },
    provenance: { repository: "github.com/example/skills", selectedPath: "review", requestedRef: commit, resolvedCommitSha: commit } });
  storeMock.mockImplementation(async (args) => ({ id: args.tenantId + "-copy", skills: [] }));
});
afterEach(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
describe("Altien skill catalog", () => {
  it("lists deployment-curated metadata without private source configuration", async () => {
    expect(await listSkillCatalog()).toEqual([{ id: source.id, displayName: source.displayName, description: source.description, commit }]);
    expect(getConfigMock).toHaveBeenCalledWith("altien-skill-catalog");
  });
  it("rejects mutable refs, duplicate IDs and untrusted URL forms", () => {
    for (const url of ["https://github.com/example/skills", source.url.replace(commit, "main"), source.url.replace("github.com", "other.example"), source.url + "/../escape"]) {
      expect(() => parseSkillCatalog(JSON.stringify([{ ...source, url }]))).toThrow("The Altien catalog is unavailable.");
    }
    expect(() => parseSkillCatalog(JSON.stringify([source, source]))).toThrow();
  });
  it("never fetches a source selected outside the catalog", async () => {
    await expect(importCatalogSkill({ catalogId: "unlisted", tenantId: "tenant-a", importedBy: "admin" })).rejects.toMatchObject({ status: 404 });
    expect(acquireMock).not.toHaveBeenCalled(); expect(storeMock).not.toHaveBeenCalled();
  });
  it("imports fresh tenant copies through the review pipeline", async () => {
    expect((await importCatalogSkill({ catalogId: source.id, tenantId: "tenant-a", importedBy: "admin-a" })).id).toBe("tenant-a-copy");
    expect((await importCatalogSkill({ catalogId: source.id, tenantId: "tenant-b", importedBy: "admin-b" })).id).toBe("tenant-b-copy");
    expect(storeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ tenantId: "tenant-a", importedBy: "admin-a", sourceKind: "github", catalog: { id: source.id, displayName: source.displayName, commit } }));
    expect(storeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ tenantId: "tenant-b", importedBy: "admin-b" }));
  });
  it("rejects source/commit drift before writing tenant data", async () => {
    acquireMock.mockResolvedValueOnce({ provenance: { repository: "github.com/example/skills", selectedPath: "review", resolvedCommitSha: "b".repeat(40) } });
    await expect(importCatalogSkill({ catalogId: source.id, tenantId: "tenant-a", importedBy: "admin" })).rejects.toMatchObject({ status: 502 });
    expect(storeMock).not.toHaveBeenCalled();
  });
  it("uses the platform vault credential before revision environment", async () => {
    process.env.KEY_VAULT_NAME = "example-vault"; process.env.ALTIEN_SKILL_CATALOG_GITHUB_TOKEN = "environment";
    getKeyVaultConfigMock.mockResolvedValue("vault");
    await importCatalogSkill({ catalogId: source.id, tenantId: "tenant-a", importedBy: "admin" });
    expect(acquireMock).toHaveBeenCalledWith({ url: source.url, token: "vault" });
  });
  it("keeps an unconfigured install unchanged and fails closed on a configured vault outage", async () => {
    getConfigMock.mockRejectedValue(new Error("No vault configured"));
    expect(await listSkillCatalog()).toEqual([]);
    process.env.KEY_VAULT_NAME = "example-vault";
    await expect(listSkillCatalog()).rejects.toThrow();
  });
});
