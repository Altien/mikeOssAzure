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
  it("defaults fresh deployments to SQLite", () => {
    expect(resolveDatabaseProvider({})).toBe("sqlite");
  });

  it("honors an explicit SQLite provider", () => {
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

  it("rejects the removed Supabase provider", () => {
    expect(() =>
      resolveDatabaseProvider({ MIKE_DATABASE_PROVIDER: "supabase" }),
    ).toThrow('Unsupported MIKE_DATABASE_PROVIDER "supabase"');
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

});
