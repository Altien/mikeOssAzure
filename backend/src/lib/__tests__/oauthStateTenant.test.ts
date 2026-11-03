// Multi-tenant issue 008: unauthenticated OAuth callbacks run as the tenant
// and user recorded on their state row.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookups: Array<{ table: string; columns: string; hash: string }> = [];
let row: Record<string, unknown> | null = null;

vi.mock("../supabase", () => ({
  createPlatformSupabase: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (_column: string, hash: string) => ({
          maybeSingle: async () => {
            lookups.push({ table, columns, hash });
            return { data: row, error: null };
          },
        }),
      }),
    }),
  }),
}));

import { runWithOAuthStateTenant } from "../oauthStateTenant";
import { currentTenant } from "../tenantContext";

beforeEach(() => {
  lookups.length = 0;
  row = null;
});

describe("runWithOAuthStateTenant", () => {
  it("runs the callback as the state row's tenant and user", async () => {
    row = { tenant_id: "tenant-b", user_id: "user-b" };
    const seen = await runWithOAuthStateTenant("user_mcp_oauth_states", "raw-state", async () => currentTenant());
    expect(seen).toEqual({ tenantId: "tenant-b", userId: "user-b" });
    expect(lookups).toEqual([{
      table: "user_mcp_oauth_states",
      columns: "tenant_id, user_id",
      hash: createHash("sha256").update("raw-state").digest("hex"),
    }]);
  });

  it("reads the GitHub skills state's creator as the user", async () => {
    row = { tenant_id: "tenant-c", created_by: "user-c" };
    const seen = await runWithOAuthStateTenant("altien_skill_github_oauth_states", "s", async () => currentTenant());
    expect(seen).toEqual({ tenantId: "tenant-c", userId: "user-c" });
    expect(lookups[0].columns).toBe("tenant_id, created_by");
  });

  it("runs without a tenant when no state row matches (the callback then rejects it)", async () => {
    const seen = await runWithOAuthStateTenant("user_mcp_oauth_states", "unknown", async () => currentTenant());
    expect(seen).toBeUndefined();
  });

  it("does not look anything up for an empty state", async () => {
    await runWithOAuthStateTenant("user_mcp_oauth_states", "", async () => undefined);
    expect(lookups).toHaveLength(0);
  });
});
