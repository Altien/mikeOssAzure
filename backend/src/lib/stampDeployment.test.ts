import { describe,expect,it,vi } from "vitest";
import type { Client } from "pg";
import { configureStampDeployment,maintainLedgerPartitions } from "./stampDeployment";

function fake(options:{blocked?:boolean;gaps?:boolean;pooled?:boolean}={}) {
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    if(text.startsWith("select pooled,stamp_id,region"))return {rows:[{pooled:options.pooled??false,stamp_id:options.pooled?"established":null,region:options.pooled?"uksouth":null}]};
    if(text.includes("ensure_llm_usage_partitions")){
      if(options.blocked)throw Object.assign(new Error("default partition"),{code:"23514"});
      return {rows:[{created:2}]};
    }
    if(text.includes("tenant_rls_gaps"))return {rows:options.gaps?[{object:"partition",problem:"RLS missing"}]:[]};
    if(text.startsWith("update app.install_tenancy"))return {rows:[{singleton:true}]};
    return {rows:[],values};
  });
  return {query,db:{query} as unknown as Client};
}
describe("migration-owner stamp deployment",()=>{
  it("atomically configures pooled metadata and creates at least 25 months ahead",async()=>{
    const {query,db}=fake();
    expect(await configureStampDeployment(db,{mode:"pooled",provider:"local",localDevelopment:true,stampId:"local-a",region:"local",fallbackTenantId:null},new Date("2026-10-28T00:00:00Z"))).toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("update app.install_tenancy"),[true,null,"local-a","local"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ensure_llm_usage_partitions"),["2026-10-01",26]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });
  it("uses a scoped lookup for the single-install fallback without creating a tenant",async()=>{
    const {query,db}=fake();
    await configureStampDeployment(db,{mode:"single",provider:"local",localDevelopment:true,fallbackTenantId:"default"});
    expect(query).toHaveBeenCalledWith(expect.stringContaining("set_config"),['{"tenant_id":"default"}']);
    expect(query.mock.calls.some(([sql])=>sql.includes("insert into public.tenants"))).toBe(false);
  });
  it("fails and rolls back when default-partition rows block a future partition",async()=>{
    const {query,db}=fake({blocked:true});
    await expect(maintainLedgerPartitions(db)).rejects.toThrow("blocked by rows in the default partition");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(query.mock.calls.some(([sql])=>sql==="commit")).toBe(false);
  });
  it("keeps metadata and new partitions unpublished when the RLS gate fails",async()=>{
    const {query,db}=fake({gaps:true});
    await expect(configureStampDeployment(db,{mode:"single",provider:"local",localDevelopment:true,fallbackTenantId:"default"})).rejects.toThrow("Tenant RLS gate failed");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });
});

it("cannot downgrade or rename an established pooled stamp during deployment",async()=>{
  for(const config of [
    {mode:"single" as const,provider:"local",localDevelopment:true,fallbackTenantId:"default"},
    {mode:"pooled" as const,provider:"local",localDevelopment:true,fallbackTenantId:null,stampId:"other",region:"uksouth"},
    {mode:"pooled" as const,provider:"local",localDevelopment:true,fallbackTenantId:null,stampId:"established",region:"eastus"},
  ]) {
    const {query,db}=fake({pooled:true});
    await expect(configureStampDeployment(db,config)).rejects.toThrow("cannot be changed");
    expect(query.mock.calls.some(([sql])=>sql.startsWith("update app.install_tenancy"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  }
});