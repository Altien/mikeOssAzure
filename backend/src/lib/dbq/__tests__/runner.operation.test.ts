import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { DbJob } from "../types";
const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../observability/sentry")>()),
  reportError: () => { captured.push({ ...Sentry.getIsolationScope().getScopeData().tags }); return "event"; },
}));
import { resetSentryForTests } from "../../observability/sentry";
import { processClaimedJob } from "../runner";

afterEach(async () => { await Sentry.close(); resetSentryForTests(); captured.length = 0; vi.restoreAllMocks(); });

it.each(["future.kind", "storage.cleanup"])("isolates an unknown %s job's dispatch operation", async (kind) => {
  Sentry.init({
    dsn: "https://test@sentry.invalid/1",
    defaultIntegrations: false,
    transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
  });
  resetSentryForTests("official", { initialized: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const updates: Array<Record<string, unknown>> = [];
  // Dev drift: terminal state publication uses the canonical live-claim RPC.
  const db = { rpc: vi.fn(async (name: string, payload: Record<string, unknown>) => {
    expect(name).toBe("finish_db_job");
    expect(payload).toMatchObject({ p_id: "job-1", p_attempts: 1, p_claim_token: "claim-1" });
    updates.push(payload);
    return { data: true, error: null };
  }) };
  const job = { id: "job-1", kind, attempts: 1, max_attempts: 3, claim_token: "claim-1", claimed_at: "2026-10-26T00:00:00Z" } as DbJob;
  await Sentry.withIsolationScope(async () => {
    Sentry.getIsolationScope().setTag("operation", "chat.turn");
    await processClaimedJob(db as never, {}, job);
    expect(captured).toEqual([{ operation: "jobs.dispatch" }]);
    expect(Sentry.getIsolationScope().getScopeData().tags.operation).toBe("chat.turn");
  });
  expect(updates[0]?.p_status).toBe(kind === "storage.cleanup" ? "pending" : "failed");
});
