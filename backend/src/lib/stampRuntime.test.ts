import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ values: {} as Record<string,string>, vault: vi.fn(), databaseUri: vi.fn(), configFailure: false, tenantProbe: vi.fn() }));
// The tenant role probe has its own suite (tenantDatabaseProbe.test.ts).
vi.mock("./tenantDatabaseProbe", () => ({ probeTenantPostgrestPath: mocks.tenantProbe }));
vi.mock("./config", () => ({
  getConfig: async (name: string) => {
    if (mocks.configFailure) throw new Error("Vault is unavailable");
    if (!(name in mocks.values)) throw Object.assign(new Error("Missing"), { statusCode: 404 });
    return mocks.values[name];
  },
  getKeyVaultConfig: mocks.vault,
}));
vi.mock("./postgresSession", () => ({ streamRunDatabaseUri: mocks.databaseUri }));
import { probeStampRuntime, type StampRuntimeMetadata } from "./stampRuntime";
import { getTenancyMode, resetFrozenTenancyModeForTests } from "./tenancyMode";
import type { Db } from "./supabase";

const keys = ["NODE_ENV","AUTH_PROVIDER","TENANCY_MODE","KEY_VAULT_NAME","AZURE_CLIENT_ID","SUPABASE_URL","API_PUBLIC_URL"] as const;
let saved: Record<string,string | undefined>;
let metadata: StampRuntimeMetadata;
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  Object.assign(process.env,{ NODE_ENV:"test",AUTH_PROVIDER:"local",TENANCY_MODE:"pooled",KEY_VAULT_NAME:"test-vault" });
  delete process.env.API_PUBLIC_URL;
  resetFrozenTenancyModeForTests();
  mocks.values = { "tenancy-mode":"pooled","auth-provider":"local","stamp-id":"stamp-a","stamp-region":"uksouth" };
  mocks.configFailure = false;
  mocks.tenantProbe.mockReset().mockResolvedValue(undefined);
  mocks.databaseUri.mockReset().mockResolvedValue("postgresql://session-owner@db:5432/mike");
  mocks.vault.mockReset().mockRejectedValue(Object.assign(new Error("Missing"),{statusCode:404}));
  metadata = { pooled:true,fallback_tenant_id:null,stamp_id:"stamp-a",region:"uksouth",platform_credentials:[] };
  rpc = vi.fn(async () => ({ data:metadata,error:null }));
});
afterEach(() => {
  resetFrozenTenancyModeForTests();
  for(const key of keys) { if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key]; }
});
const db = () => ({rpc} as unknown as Db);
function cloud() {
  process.env.NODE_ENV="production";process.env.AUTH_PROVIDER="entra";process.env.AZURE_CLIENT_ID="managed-identity";process.env.SUPABASE_URL="https://postgrest.example.test";
  Object.assign(mocks.values,{
    "auth-provider":"entra","backend-public-url":"https://api.example.test","frontend-url":"https://app.example.test",
    "word-addin-url":"https://word.example.test","pooled-onboarding-url":"https://control.example.test/onboarding",
    "altien-entra-tenant-id":"external-directory","altien-entra-authority":"https://external.ciamlogin.com/external-directory",
    "altien-entra-issuer":"https://external.ciamlogin.com/external-directory/v2.0/","altien-entra-jwks-uri":"https://external.ciamlogin.com/keys",
    "altien-entra-client-id":"external-browser","altien-entra-backend-client-id":"external-api",
    "altien-entra-client-secret":"external-secret","entra-client-id":"enterprise-browser","entra-client-secret":"enterprise-secret","entra-backend-client-id":"enterprise-api",
    "postgrest-jwt-secret":"test-signing-secret-that-exceeds-32-characters",
  });
}
describe("stamp startup gate",()=>{
  it("verifies the database even when the server selects single mode",async()=>{
    mocks.values["tenancy-mode"]="single";
    await expect(probeStampRuntime(db())).rejects.toThrow("tenancy mode");
    expect(rpc).toHaveBeenCalledWith("stamp_runtime_metadata");
  });
  it("keeps existing single installs with no adopted fallback compatible",async()=>{
    mocks.values["tenancy-mode"]="single";
    metadata={...metadata,pooled:false,stamp_id:null,region:null};
    await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:false});
    expect(mocks.databaseUri).not.toHaveBeenCalled();
  });
  it("checks local pooled metadata and freezes the validated mode",async()=>{
    await probeStampRuntime(db());
    mocks.values["tenancy-mode"]="single";
    expect(await getTenancyMode()).toBe("pooled");
    expect(mocks.vault).not.toHaveBeenCalled();
  });
  it.each([{stamp_id:"different"},{region:"eastus"},{fallback_tenant_id:"default"}])("refuses a pooled identity/fallback mismatch: %j",async change=>{
    Object.assign(metadata,change);
    await expect(probeStampRuntime(db())).rejects.toThrow("identity or fallback");
  });
  it("stops startup when the tenant role check fails, before freezing the mode",async()=>{
    mocks.tenantProbe.mockRejectedValueOnce(new Error("Tenant database check failed"));
    await expect(probeStampRuntime(db())).rejects.toThrow("Tenant database check failed");
    mocks.values["tenancy-mode"]="single";
    expect(await getTenancyMode()).toBe("single");
  });
  it("refuses pooled RLS rollback",async()=>{
    mocks.values["tenant-rls-enforced"]="false";
    await expect(probeStampRuntime(db())).rejects.toThrow("enforced tenant RLS");
  });
  it("fails closed on metadata and config service errors",async()=>{
    rpc.mockResolvedValueOnce({data:null,error:{message:"unavailable"}} as never);
    await expect(probeStampRuntime(db())).rejects.toThrow("metadata is unavailable");
    mocks.configFailure=true;
    await expect(probeStampRuntime(db())).rejects.toThrow("Vault is unavailable");
  });
  it("never gives production local auth the Azure development exception",async()=>{
    process.env.NODE_ENV="production";
    await expect(probeStampRuntime(db())).rejects.toThrow("Entra authentication");
  });
  it("validates the production pooled runtime before accepting traffic",async()=>{
    cloud();
    await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
    expect(mocks.databaseUri).toHaveBeenCalledOnce();
  });
  it("accepts a Microsoft-only pooled runtime without any External ID setting",async()=>{
    cloud();
    for(const name of Object.keys(mocks.values))if(name.startsWith("altien-entra-"))delete mocks.values[name];
    await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
  });
  it("requires deployment URLs and managed identity in production",async()=>{
    cloud();delete mocks.values["frontend-url"];
    await expect(probeStampRuntime(db())).rejects.toThrow("frontend-url");
    cloud();delete process.env.AZURE_CLIENT_ID;
    await expect(probeStampRuntime(db())).rejects.toThrow("managed identity");
  });
  it("checks the platform tier credentials selected by active tenant price policies",async()=>{
    cloud();metadata.platform_credentials=[{tier:"standard",provider:"openai",model:"example-model"}];
    await expect(probeStampRuntime(db())).rejects.toThrow("Platform credential unavailable");
    mocks.vault.mockImplementation(async(name:string)=>{
      if(name==="platform-standard-openai-api-key")return "tier-secret";
      throw Object.assign(new Error("Missing"),{statusCode:404});
    });
    await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
    expect(mocks.vault).toHaveBeenCalledWith("platform-standard-openai-api-key");
  });
  describe("administrator-entered providers",()=>{
    function vaultHolding(values:Record<string,string>){
      mocks.vault.mockImplementation(async(name:string)=>{
        if(name in values)return values[name];
        throw Object.assign(new Error("Missing"),{statusCode:404});
      });
    }
    it("needs Meta's key and model names, but not its optional base URL",async()=>{
      cloud();metadata.platform_credentials=[{tier:"standard",provider:"meta",model:"meta/muse-spark-1.1"}];
      vaultHolding({"meta-api-key":"org-key"});
      await expect(probeStampRuntime(db())).rejects.toThrow("provider meta");
      vaultHolding({"meta-models":"muse-spark-1.1"});
      await expect(probeStampRuntime(db())).rejects.toThrow("provider meta");
      vaultHolding({"meta-api-key":"org-key","meta-models":"muse-spark-1.1"});
      await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
    });
    it("also needs TokenJuice's base URL, which has no default",async()=>{
      cloud();metadata.platform_credentials=[{tier:"standard",provider:"tokenjuice",model:"tokenjuice/juice-large"}];
      vaultHolding({"tokenjuice-api-key":"org-key","tokenjuice-models":"juice-large"});
      await expect(probeStampRuntime(db())).rejects.toThrow("provider tokenjuice");
      vaultHolding({"tokenjuice-api-key":"org-key","tokenjuice-models":"juice-large","tokenjuice-base-url":"https://tj.example.test/v1"});
      await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
    });
    it("accepts a tier's own settings",async()=>{
      cloud();metadata.platform_credentials=[{tier:"standard",provider:"meta",model:"meta/muse-spark-1.1"}];
      vaultHolding({"platform-standard-meta-api-key":"tier-key","platform-standard-meta-models":"muse-spark-1.1"});
      await expect(probeStampRuntime(db())).resolves.toMatchObject({pooled:true});
    });
    it("does not suppress a vault outage on these settings",async()=>{
      cloud();metadata.platform_credentials=[{tier:"standard",provider:"meta",model:"meta/muse-spark-1.1"}];
      mocks.vault.mockRejectedValue(new Error("Credential vault unavailable"));
      await expect(probeStampRuntime(db())).rejects.toThrow("Credential vault unavailable");
    });
  });
  it("does not suppress a credential-vault outage",async()=>{
    cloud();metadata.platform_credentials=[{tier:"standard",provider:"openai",model:"example-model"}];
    mocks.vault.mockRejectedValue(new Error("Credential vault unavailable"));
    await expect(probeStampRuntime(db())).rejects.toThrow("Credential vault unavailable");
  });
});
