import { describe, expect, it } from "vitest";
import { runWithRequestId } from "../../requestContext";
import { currentTenant, runWithTenant } from "../../tenantContext";
import { bindLogContext, currentContextLight, runWithContextLight, withLogContext } from "../contextLight";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("ContextLight", () => {
  it("projects tenant, user and request id, never email, roles or flags", () => {
    const ctx = runWithRequestId("req-1", () =>
      runWithTenant({ tenantId: "contoso", userId: "u-1", userEmail: "a@b.c", roles: ["TenantAdmin"], pooled: true, readOnly: true },
        () => currentContextLight()));
    expect(ctx).toEqual({ tenantId: "contoso", userId: "u-1", requestId: "req-1" });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(currentContextLight()).toEqual({});
  });

  it("adds overlay ids with withLogContext, surviving await, setTimeout and setInterval", async () => {
    const seen: unknown[] = [];
    await runWithTenant({ tenantId: "contoso" }, () => withLogContext({ jobId: "job-1" }, async () => {
      await tick();
      seen.push(currentContextLight());
      await new Promise<void>((resolve) => setTimeout(() => { seen.push(currentContextLight()); resolve(); }, 1));
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => { clearInterval(timer); seen.push(currentContextLight()); resolve(); }, 1);
      });
    }));
    expect(seen).toEqual(Array(3).fill({ tenantId: "contoso", jobId: "job-1" }));
  });

  it("bindLogContext covers the rest of the async function and what it schedules, not its caller", async () => {
    let later: Promise<unknown> = Promise.resolve();
    const route = async () => {
      await tick();
      bindLogContext({ chatId: "chat-1", runId: "run-1" });
      // Created after the bind and awaited elsewhere, like titlePromise.
      later = tick().then(() => currentContextLight());
      await tick();
      return currentContextLight();
    };
    const caller = runWithTenant({ tenantId: "contoso", userId: "u-1" }, async () => {
      const inside = await route();
      return { inside, after: currentContextLight() };
    });
    const { inside, after } = await caller;
    expect(inside).toEqual({ tenantId: "contoso", userId: "u-1", chatId: "chat-1", runId: "run-1" });
    expect(await later).toEqual(inside);
    expect(after).toEqual({ tenantId: "contoso", userId: "u-1" });
  });

  it("isolates concurrent scopes", async () => {
    const run = (id: string) => withLogContext({ runId: id }, async () => {
      await tick();
      return currentContextLight().runId;
    });
    expect(await Promise.all([run("a"), run("b"), run("c")])).toEqual(["a", "b", "c"]);
  });

  it("runWithContextLight hands off ids explicitly without opening a tenant scope", async () => {
    const result = await runWithContextLight({ tenantId: "contoso", userId: "u-1", runId: "r-1" }, async () => {
      await tick();
      return { ctx: currentContextLight(), tenant: currentTenant() };
    });
    expect(result).toEqual({ ctx: { tenantId: "contoso", userId: "u-1", runId: "r-1" }, tenant: undefined });
  });

  it("lets the tenant store win over overlay tenant and user", () => {
    const ctx = runWithContextLight({ tenantId: "other", userId: "u-x", runId: "r-1" }, () =>
      runWithTenant({ tenantId: "contoso" }, () => currentContextLight()));
    expect(ctx).toEqual({ tenantId: "contoso", runId: "r-1" });
  });
});
