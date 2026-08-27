import { describe, expect, it } from "vitest";
import { resolveAuthProvider } from "../authProvider";

describe("auth provider selection", () => {
  it("defaults fresh deployments to Supabase Auth", () => {
    expect(resolveAuthProvider({})).toBe("supabase");
  });

  it("honors explicit Supabase and local providers", () => {
    expect(resolveAuthProvider({ MIKE_AUTH_PROVIDER: "supabase" })).toBe(
      "supabase",
    );
    expect(resolveAuthProvider({ MIKE_AUTH_PROVIDER: "LOCAL" })).toBe("local");
  });

  it("keeps existing SQLite installations on local auth", () => {
    expect(resolveAuthProvider({ MIKE_DATABASE_PROVIDER: "sqlite" })).toBe(
      "local",
    );
    expect(resolveAuthProvider({ SQLITE_DB_PATH: "./data/mike.sqlite" })).toBe(
      "local",
    );
  });

  it("rejects unknown providers", () => {
    expect(() => resolveAuthProvider({ MIKE_AUTH_PROVIDER: "oauth" })).toThrow(
      'Unsupported MIKE_AUTH_PROVIDER "oauth"',
    );
  });
});
