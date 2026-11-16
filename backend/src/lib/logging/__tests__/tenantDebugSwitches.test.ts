import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBUG_SWITCH_MAX_MS, TenantDebugSwitches, type DebugSwitchRow } from "../tenantDebugSwitches";
import { FakeClock } from "./helpers";

const REFRESH = 30_000;

function setup() {
  const clock = new FakeClock();
  const changes: Array<[string, string | null]> = [];
  const errors: unknown[] = [];
  const switches = new TenantDebugSwitches({
    clock, refreshMs: REFRESH,
    onChange: (tenantId, until) => changes.push([tenantId, until ? until.toISOString() : null]),
    onError: (err) => errors.push(err),
  });
  return { clock, changes, errors, switches };
}

const rows = (...items: DebugSwitchRow[]) => async () => items;

afterEach(() => { vi.useRealTimers(); });

describe("TenantDebugSwitches", () => {
  it("is off before the first refresh and for unknown or missing tenants", async () => {
    const { clock, switches } = setup();
    expect(switches.isOn("contoso")).toBe(false);
    await switches.refresh(rows({ tenantId: "contoso", until: new Date(clock.now() + 60_000) }));
    expect(switches.isOn("contoso")).toBe(true);
    expect(switches.isOn("fabrikam")).toBe(false);
    expect(switches.isOn(undefined)).toBe(false);
  });

  it("turns off exactly at expiry without another refresh", async () => {
    const { clock, switches } = setup();
    await switches.refresh(rows({ tenantId: "contoso", until: new Date(clock.now() + 10_000) }));
    clock.advance(9_999);
    expect(switches.isOn("contoso")).toBe(true);
    clock.advance(1);
    expect(switches.isOn("contoso")).toBe(false);
  });

  it("clamps a stored end beyond 24 hours, once, so it does not move every poll", async () => {
    const { clock, changes, switches } = setup();
    const start = clock.now();
    const read = rows({ tenantId: "contoso", until: new Date(start + 7 * DEBUG_SWITCH_MAX_MS) });
    await switches.refresh(read);
    clock.advance(REFRESH);
    await switches.refresh(read);
    expect(changes).toEqual([["contoso", new Date(start + DEBUG_SWITCH_MAX_MS).toISOString()]]);
    clock.ms = start + DEBUG_SWITCH_MAX_MS - 1;
    await switches.refresh(read);
    expect(switches.isOn("contoso")).toBe(true);
    clock.advance(1);
    expect(switches.isOn("contoso")).toBe(false);
  });

  it("fails closed on a read error and reports once per failure streak", async () => {
    const { clock, errors, switches } = setup();
    const ok = rows({ tenantId: "contoso", until: new Date(clock.now() + 3_600_000) });
    const failing = async () => { throw new Error("db down"); };
    await switches.refresh(ok);
    await switches.refresh(failing);
    await expect(switches.refresh(failing)).resolves.toBeUndefined();
    expect(switches.isOn("contoso")).toBe(false);
    expect(errors).toHaveLength(1);
    await switches.refresh(ok);
    expect(switches.isOn("contoso")).toBe(true);
    await switches.refresh(failing);
    expect(errors).toHaveLength(2);
  });

  it("turns off when the last successful poll is older than three intervals", async () => {
    const { clock, switches } = setup();
    await switches.refresh(rows({ tenantId: "contoso", until: new Date(clock.now() + 3_600_000) }));
    clock.advance(3 * REFRESH);
    expect(switches.isOn("contoso")).toBe(true);
    clock.advance(1);
    expect(switches.isOn("contoso")).toBe(false);
  });

  it("reports on, extended, cleared and expired transitions", async () => {
    const { clock, changes, switches } = setup();
    const t0 = clock.now();
    await switches.refresh(rows({ tenantId: "a", until: new Date(t0 + 60_000) }, { tenantId: "b", until: new Date(t0 + 1_000) }));
    await switches.refresh(rows({ tenantId: "a", until: new Date(t0 + 120_000) }, { tenantId: "b", until: new Date(t0 + 1_000) }));
    clock.advance(2_000);
    await switches.refresh(rows());
    expect(changes).toEqual([
      ["a", new Date(t0 + 60_000).toISOString()],
      ["b", new Date(t0 + 1_000).toISOString()],
      ["a", new Date(t0 + 120_000).toISOString()],
      ["a", null],
      ["b", null],
    ]);
  });

  it("start() refreshes now and on an unref'd interval; stop() clears the timer", async () => {
    vi.useFakeTimers();
    const { switches } = setup();
    const read = vi.fn(async () => [] as DebugSwitchRow[]);
    switches.start(read);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH);
    expect(read).toHaveBeenCalledTimes(2);
    switches.stop();
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
