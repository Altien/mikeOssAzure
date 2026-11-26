import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {resetPostgrestJwtState,tenantDbRole} from "./supabase";
import {freezeTenancyMode,resetFrozenTenancyModeForTests} from "./tenancyMode";
const keys=["TENANCY_MODE","TENANT_RLS_ENFORCED"] as const;
let saved:Record<string,string|undefined>;
beforeEach(()=>{
  saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.TENANCY_MODE="pooled";process.env.TENANT_RLS_ENFORCED="false";
  resetPostgrestJwtState();resetFrozenTenancyModeForTests();
});
afterEach(()=>{
  resetPostgrestJwtState();resetFrozenTenancyModeForTests();
  for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
});
describe("pooled runtime RLS fence",()=>{
  it("cannot switch request clients to service_role after a runtime config edit",async()=>{
    await expect(tenantDbRole()).rejects.toThrow("enforced tenant RLS");
  });
  it("keeps the guard for a frozen pooled process even if mode config changes",async()=>{
    freezeTenancyMode("pooled");process.env.TENANCY_MODE="single";
    await expect(tenantDbRole()).rejects.toThrow("enforced tenant RLS");
  });
  it("preserves the legacy single-install rollback",async()=>{
    process.env.TENANCY_MODE="single";
    expect(await tenantDbRole()).toBe("service_role");
  });
  it("uses tenant_app when pooled enforcement is enabled",async()=>{
    process.env.TENANT_RLS_ENFORCED="true";
    expect(await tenantDbRole()).toBe("tenant_app");
  });
});
