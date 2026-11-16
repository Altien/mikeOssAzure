// Per-tenant debug switch cache (docs/structured-logging.md, "Debug switch").
//
// One poll per JS isolate every 30 s replaces the whole map; isOn() is a
// synchronous map lookup, so the debug gate never makes a database call per
// record. Expiry is exact to the millisecond between polls. Fails closed: a
// read error clears the map, and a poll that has not succeeded for three
// intervals turns everything off. No database import here (see
// tenantDebugStore.ts), so tests drive it with a fake reader and clock.
import type { Clock, DebugGate } from "./types";

export type DebugSwitchRow = { tenantId: string; until: Date };

export const DEBUG_SWITCH_REFRESH_MS = 30_000;
export const DEBUG_SWITCH_MAX_MS = 24 * 60 * 60_000;

type Entry = { raw: number; until: number };

export class TenantDebugSwitches implements DebugGate {
  private entries = new Map<string, Entry>();
  /** The end last passed to onChange per tenant that is on. */
  private readonly reported = new Map<string, number>();
  private lastSuccessAt: number | null = null;
  private failing = false;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clock: Clock;
  private readonly refreshMs: number;
  private readonly onChange?: (tenantId: string, until: Date | null) => void;
  private readonly onError?: (err: unknown) => void;

  constructor(deps: {
    clock: Clock;
    refreshMs?: number;
    onChange?: (tenantId: string, until: Date | null) => void;
    onError?: (err: unknown) => void;
  }) {
    this.clock = deps.clock;
    this.refreshMs = deps.refreshMs ?? DEBUG_SWITCH_REFRESH_MS;
    this.onChange = deps.onChange;
    this.onError = deps.onError;
  }

  isOn(tenantId: string | undefined): boolean {
    if (!tenantId || this.lastSuccessAt === null) return false;
    const now = this.clock.now();
    if (now - this.lastSuccessAt > 3 * this.refreshMs) return false;
    const entry = this.entries.get(tenantId);
    return entry !== undefined && now < entry.until;
  }

  async refresh(read: () => Promise<readonly DebugSwitchRow[]>): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      let rows: readonly DebugSwitchRow[];
      try {
        rows = await read();
      } catch (err) {
        this.replace(new Map());
        if (!this.failing) {
          this.failing = true;
          this.safely(() => this.onError?.(err));
        }
        return;
      }
      const now = this.clock.now();
      const next = new Map<string, Entry>();
      for (const row of rows) {
        const raw = row?.until instanceof Date ? row.until.getTime() : Number.NaN;
        if (typeof row?.tenantId !== "string" || !row.tenantId || !Number.isFinite(raw)) continue;
        const previous = this.entries.get(row.tenantId);
        // Clamp once per stored value, so a hand-edited row cannot exceed the
        // 24 h maximum and an unchanged row does not move its end every poll.
        const until = previous && previous.raw === raw ? previous.until : Math.min(raw, now + DEBUG_SWITCH_MAX_MS);
        if (until > now) next.set(row.tenantId, { raw, until });
      }
      this.replace(next);
      this.lastSuccessAt = now;
      this.failing = false;
    } finally {
      this.refreshing = false;
    }
  }

  start(read: () => Promise<readonly DebugSwitchRow[]>): void {
    this.stop();
    void this.refresh(read);
    this.timer = setInterval(() => void this.refresh(read), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Swap the map and report every tenant whose effective end changed since
   * it was last reported, including a switch that simply expired.
   */
  private replace(next: Map<string, Entry>): void {
    const now = this.clock.now();
    this.entries = next;
    for (const tenantId of new Set([...this.reported.keys(), ...next.keys()])) {
      const entry = next.get(tenantId);
      const after = entry && entry.until > now ? entry.until : null;
      const before = this.reported.get(tenantId) ?? null;
      if (before === after) continue;
      if (after === null) this.reported.delete(tenantId);
      else this.reported.set(tenantId, after);
      this.safely(() => this.onChange?.(tenantId, after === null ? null : new Date(after)));
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      /* a reporting callback never breaks the poller */
    }
  }
}
