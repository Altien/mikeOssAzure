import { describe, expect, it, vi } from "vitest";
import { ensureResourceAccessSummaries } from "./resourceAccessSummary";

describe("ensureResourceAccessSummaries", () => {
  it.each([
    {
      kind: "project" as const,
      grantTable: "project_access_grants",
      resourceKey: "project_id",
    },
    {
      kind: "workflow" as const,
      grantTable: "workflow_shares",
      resourceKey: "workflow_id",
    },
  ])(
    "counts direct $kind grants without making per-resource requests",
    async ({ kind, grantTable, resourceKey }) => {
      const grants = [
        { [resourceKey]: "shared-1" },
        { [resourceKey]: "shared-1" },
        { [resourceKey]: "shared-2" },
      ];
      const inQuery = vi.fn().mockResolvedValue({ data: grants, error: null });
      const select = vi.fn().mockReturnValue({ in: inQuery });
      const from = vi.fn().mockReturnValue({ select });

      const result = await ensureResourceAccessSummaries(
        { from } as never,
        kind,
        [
          { id: "shared-1", org_id: null, access_scope: "shared" },
          { id: "shared-2", org_id: null, access_scope: "shared" },
          { id: "private-1", org_id: null, access_scope: "private" },
        ],
      );

      expect(result.error).toBeNull();
      expect(result.rows).toEqual([
        {
          id: "shared-1",
          org_id: null,
          access_scope: "shared",
          direct_grant_count: 2,
        },
        {
          id: "shared-2",
          org_id: null,
          access_scope: "shared",
          direct_grant_count: 1,
        },
        { id: "private-1", org_id: null, access_scope: "private" },
      ]);
      expect(from).toHaveBeenCalledOnce();
      expect(from).toHaveBeenCalledWith(grantTable);
      expect(select).toHaveBeenCalledWith(resourceKey);
      expect(inQuery).toHaveBeenCalledWith(resourceKey, [
        "shared-1",
        "shared-2",
        "private-1",
      ]);
    },
  );
});
