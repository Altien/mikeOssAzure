import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const { getUserApiKeys } = vi.hoisted(() => ({ getUserApiKeys: vi.fn() }));

vi.mock("../../user/user.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../user/user.service")>()),
  getUserApiKeys,
}));

import { playbookConfiguration } from "../playbooks.operations";

function dbWithProfile(profile: Record<string, string | null>): Db {
  return { from: vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) query[method] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: table === "user_profiles" ? profile : null, error: null }));
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return query;
  }) } as unknown as Db;
}

