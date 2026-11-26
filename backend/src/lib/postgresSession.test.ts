import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({vault:vi.fn(),mode:"pooled"}));
vi.mock("./config",()=>({getKeyVaultConfig:mocks.vault}));
vi.mock("./tenancyMode",()=>({getTenancyMode:async()=>mocks.mode}));
import {streamRunDatabaseUri,validatePostgresSessionUri} from "./postgresSession";
const keys=["KEY_VAULT_NAME","STREAM_RUN_DATABASE_URL","NODE_ENV","AUTH_PROVIDER"] as const;
let saved:Record<string,string|undefined>;
beforeEach(()=>{
  saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{KEY_VAULT_NAME:"test",NODE_ENV:"production",AUTH_PROVIDER:"entra"});
  delete process.env.STREAM_RUN_DATABASE_URL;mocks.mode="pooled";mocks.vault.mockReset().mockResolvedValue("postgresql://runtime@db:5432/mike?sslmode=require");
});
afterEach(()=>{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
describe("direct PostgreSQL session contract",()=>{
  it("uses the separate pooled session secret for LISTEN",async()=>{
    await streamRunDatabaseUri();
    expect(mocks.vault).toHaveBeenCalledWith("postgres-session-uri");
  });
  it("retains the legacy Key Vault session source for single installs",async()=>{
    mocks.mode="single";await streamRunDatabaseUri();
    expect(mocks.vault).toHaveBeenCalledWith("pgrst-db-uri");
  });
  it("rejects common transaction pool configuration",()=>{
    expect(()=>validatePostgresSessionUri("postgresql://runtime@db:6432/mike")).toThrow("direct PostgreSQL");
    expect(()=>validatePostgresSessionUri("postgresql://runtime@db:5432/mike?pgbouncer=true")).toThrow("transaction pooling");
    expect(()=>validatePostgresSessionUri("https://db/mike")).toThrow("PostgreSQL");
  });
  it("allows the existing explicit nonproduction local endpoint",async()=>{
    delete process.env.KEY_VAULT_NAME;Object.assign(process.env,{NODE_ENV:"development",AUTH_PROVIDER:"local",STREAM_RUN_DATABASE_URL:"postgresql://runtime@127.0.0.1:55432/mike"});
    expect(await streamRunDatabaseUri()).toContain(":55432");
  });
});

it("does not hide a pooled session-vault outage behind a stale env fallback",async()=>{
  process.env.STREAM_RUN_DATABASE_URL="postgresql://runtime@db:5432/mike";
  mocks.vault.mockRejectedValue(new Error("Vault unavailable"));
  await expect(streamRunDatabaseUri()).rejects.toThrow("Vault unavailable");
});