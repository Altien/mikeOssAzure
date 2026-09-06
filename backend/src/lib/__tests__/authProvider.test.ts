import { describe, expect, it } from "vitest";
import { resolveAuthProvider } from "../authProvider";

describe("auth provider selection", () => {
  it("defaults fresh deployments to local auth", () => {
    expect(resolveAuthProvider({})).toBe("local");
  });

  it("honors the explicit local provider", () => {
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

  it("rejects the removed Supabase provider", () => {
    expect(() =>
      resolveAuthProvider({ MIKE_AUTH_PROVIDER: "supabase" }),
    ).toThrow('Unsupported MIKE_AUTH_PROVIDER "supabase"');
  });
});
