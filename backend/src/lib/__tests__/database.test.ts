import { afterEach, describe, expect, it } from "vitest";
import {
  createServerDatabase,
  resolveDatabaseProvider,
} from "../database";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("database provider selection", () => {
  it("defaults fresh deployments to Supabase", () => {
    expect(resolveDatabaseProvider({})).toBe("supabase");
  });

  it("honors an explicit provider", () => {
    expect(resolveDatabaseProvider({ MIKE_DATABASE_PROVIDER: "supabase" })).toBe("supabase");
    expect(resolveDatabaseProvider({ MIKE_DATABASE_PROVIDER: "SQLITE" })).toBe("sqlite");
  });

  it("keeps pre-provider SQLite installations working", () => {
    expect(resolveDatabaseProvider({ SQLITE_DB_PATH: "./data/mike.sqlite" })).toBe("sqlite");
  });

  it("rejects unknown providers during startup", () => {
    expect(() => resolveDatabaseProvider({ MIKE_DATABASE_PROVIDER: "mysql" })).toThrow(
      'Unsupported MIKE_DATABASE_PROVIDER "mysql"',
    );
  });

  it("creates the selected SQLite-compatible query client", () => {
    process.env.MIKE_DATABASE_PROVIDER = "sqlite";
    expect(createServerDatabase()).toEqual(
      expect.objectContaining({
        from: expect.any(Function),
        rpc: expect.any(Function),
      }),
    );
  });

  it("requires Supabase credentials when Supabase is selected", () => {
    process.env.MIKE_DATABASE_PROVIDER = "supabase";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    expect(() => createServerDatabase()).toThrow(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set",
    );
  });

  it("creates the upstream Supabase query client when configured", () => {
    process.env.MIKE_DATABASE_PROVIDER = "supabase";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-service-role-key";
    expect(createServerDatabase()).toEqual(
      expect.objectContaining({
        from: expect.any(Function),
        auth: expect.any(Object),
      }),
    );
  });
});
