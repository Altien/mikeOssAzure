import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn((url: string, key: string) => ({ url, key })),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { createServerSupabase } from "../supabase";

describe("createServerSupabase", () => {
  beforeEach(() => {
    createClient.mockClear();
    process.env.SUPABASE_URL = `https://${crypto.randomUUID()}.supabase.test`;
    process.env.SUPABASE_SECRET_KEY = crypto.randomUUID();
  });

  it("reuses one admin client for the same configuration", () => {
    const first = createServerSupabase();
    const second = createServerSupabase();

    expect(second).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  });

  it("creates a new client when the configuration changes", () => {
    const first = createServerSupabase();
    process.env.SUPABASE_SECRET_KEY = crypto.randomUUID();

    const second = createServerSupabase();

    expect(second).not.toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("rejects missing server configuration", () => {
    delete process.env.SUPABASE_URL;

    expect(() => createServerSupabase()).toThrow(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set",
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});
