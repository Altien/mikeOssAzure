import { beforeEach, describe, expect, it, vi } from "vitest";
const { rpc, platform } = vi.hoisted(() => ({ rpc: vi.fn(), platform: vi.fn() }));
vi.mock("../../../lib/supabase", () => ({ createPlatformSupabase: platform }));
import { runWithTenant } from "../../../lib/tenantContext";
import type { DbJob } from "../../../lib/dbq/types";
import { handleTenantPurge } from "../tenant-lifecycle.service";

const job = { id: "job", tenant_id: "a", claim_token: "fence" } as DbJob;
beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
  platform.mockReset().mockReturnValue({ rpc });
});
describe("tenant purge delivery", () => {
  it("passes the durable tenant and claim token to the platform-only RPC", async () => {
    await runWithTenant({ tenantId: "a" }, () => handleTenantPurge({} as never, job));
    expect(rpc).toHaveBeenCalledWith("purge_offboarded_tenant", {
      p_tenant_id: "a", p_job_id: "job", p_claim_token: "fence",
    });
  });
  it("refuses missing or mismatched tenant scopes before creating a platform client", async () => {
    await expect(handleTenantPurge({} as never, job)).rejects.toThrow(/matching tenant/);
    await expect(runWithTenant({ tenantId: "b" }, () => handleTenantPurge({} as never, job))).rejects.toThrow(/matching tenant/);
    await expect(runWithTenant({ tenantId: "a" }, () => handleTenantPurge({} as never, { ...job, claim_token: null }))).rejects.toThrow(/claim fence/);
    expect(platform).not.toHaveBeenCalled();
  });
  it.each([{ data: false, error: null }, { data: null, error: { code: "42501" } }])("throws for retry when the RPC refuses completion", async response => {
    rpc.mockResolvedValue(response);
    await expect(runWithTenant({ tenantId: "a" }, () => handleTenantPurge({} as never, job))).rejects.toThrow(/did not complete/);
  });
});
