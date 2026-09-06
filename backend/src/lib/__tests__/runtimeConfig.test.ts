import { describe, expect, it } from "vitest";
import { validateRuntimeConfiguration } from "../runtimeConfig";

const validProduction = {
  NODE_ENV: "production",
  MIKE_AUTH_PROVIDER: "local",
  MIKE_DATABASE_PROVIDER: "sqlite",
  MIKE_STORAGE_PROVIDER: "sqlite",
  FRONTEND_URL: "https://app.example.test",
  API_PUBLIC_URL: "https://app.example.test/api",
} as NodeJS.ProcessEnv;

describe("runtime authentication configuration", () => {
  it("accepts local auth without Supabase credentials", () => {
    expect(() =>
      validateRuntimeConfiguration({
        MIKE_AUTH_PROVIDER: "local",
        MIKE_DATABASE_PROVIDER: "sqlite",
        MIKE_STORAGE_PROVIDER: "sqlite",
      }),
    ).not.toThrow();
  });

  it("rejects the removed Supabase auth provider", () => {
    expect(() =>
      validateRuntimeConfiguration({ MIKE_AUTH_PROVIDER: "supabase" }),
    ).toThrow(/This fork uses local SQLite authentication/);
  });

  it("accepts a complete production configuration", () => {
    expect(() => validateRuntimeConfiguration(validProduction)).not.toThrow();
  });

  it("rejects insecure production callback configuration", () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...validProduction,
        FRONTEND_URL: "http://app.example.test",
        API_PUBLIC_URL: "http://app.example.test/api",
      }),
    ).toThrow(/FRONTEND_URL must use https in production/);
  });

  it("requires a handoff encryption secret when Word auth is enabled", () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...validProduction,
        WORD_ADDIN_URL: "https://word.example.test",
      }),
    ).toThrow(/AUTH_HANDOFF_ENCRYPTION_SECRET is required/);
  });

  it("does not infer a hosted provider from obsolete credentials", () => {
    expect(() =>
      validateRuntimeConfiguration({
        MIKE_AUTH_PROVIDER: "local",
        MIKE_DATABASE_PROVIDER: "sqlite",
        MIKE_STORAGE_PROVIDER: "sqlite",
        SUPABASE_URL: "https://obsolete.example.test",
        SUPABASE_ANON_KEY: "legacy-anon-key",
      }),
    ).not.toThrow();
  });
});
