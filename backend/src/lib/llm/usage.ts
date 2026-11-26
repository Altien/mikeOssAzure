// LLM usage ledger (multi-tenant issue 015). Every model call made through
// streamWithProvider / completeWithProvider (providers.ts) produces exactly one
// row in public.llm_usage_events (migration 0182): one logical call, however
// many tool-loop steps or reasoning-level retries it took.
//
// Tenant and user come from the ambient tenant scope (lib/tenantContext.ts);
// the database row takes its tenant_id from the column default (the request's
// PostgREST claim, else the single-tenant install fallback), so the ledger
// never trusts a tenant id passed in by a caller.
//
// Recording never fails the model call: a ledger write error is logged and
// dropped. Under vitest (NODE_ENV=test) the default sink is a no-op so suites
// that stub `fetch` never see a ledger insert; tests that count rows install
// their own sink with setLlmUsageSink().
import { currentRequestId } from "../requestContext";
import { safeErrorLog } from "../safeError";
import { currentTenant } from "../tenantContext";
import { chargeTenantLlmTokens } from "../tenantRateLimit";
import type { LlmFeature } from "./types";
import { reserveTenantCredits, type TenantCreditReservation } from "../tenantCredits";
import { recordTenantMetric } from "../tenantMetrics";

/**
 * Whose organisation credential paid: platform or the tenant's BYO Key Vault
 * reference (014). BYO usage is metered but bypasses platform credit budgets.
 * A hybrid tenant's referenced provider and a member's own key also count as BYO.
 */
export type LlmKeyMode = "platform" | "byo";
export type LlmCallOutcome = "completed" | "aborted" | "failed";

/**
 * Compatibility default for unbudgeted/BYO calls. Paid pooled calls capture
 * the immutable price version returned by their durable reservation.
 */
export const LLM_PRICE_TABLE_VERSION: string | null = null;

export type LlmUsageEvent = {
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  feature: LlmFeature;
  provider: string;
  model: string;
  keyMode: LlmKeyMode;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
  estimated: boolean;
  outcome: LlmCallOutcome;
  latencyMs: number;
  providerResponseId: string | null;
  priceTableVersion: string | null;
  creditReservationId?: string;
  creditPeriod?: string;
};

export type LlmCallDescriptor = {
  feature: LlmFeature;
  provider: string;
  model: string;
  keyMode: LlmKeyMode;
};

/** The AI SDK `LanguageModelUsage` fields the ledger reads. */
export type UsageLike =
  | {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      inputTokenDetails?: {
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      };
    }
  | undefined;

// Rough characters-per-token for output produced by a step that never
// reported usage (an aborted or failed stream). Marked `estimated` in the row.
const CHARS_PER_TOKEN = 4;

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/** Accumulates one logical model call's usage across its steps. */
export class LlmUsageMeter {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private steps = 0;
  private unreportedChars = 0;
  private pendingInputBound = 0;
  private hadEstimatedUsage = false;
  private providerResponseId: string | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly call: LlmCallDescriptor, readonly reservation?: TenantCreditReservation) {}

  /** Called before each actual paid provider step, including tool-loop prompts. */
  async beforeStep(prompt: unknown): Promise<void> {
    if (!this.reservation) return;
    this.pendingInputBound = await this.reservation.beforeStep(prompt);
  }

  /** A rejected reasoning parameter proves this attempt never ran inference. */
  discardUnbilledStep(): void {
    this.pendingInputBound = 0;
    this.unreportedChars = 0;
  }

  /** A provider-reported step (AI SDK `finish-step`, or a completion). */
  addStep(usage: UsageLike, responseId?: string | null): void {
    this.steps += 1;
    const inputMissing = usage?.inputTokens === undefined;
    const outputMissing = usage?.outputTokens === undefined;
    this.inputTokens += inputMissing ? this.pendingInputBound : count(usage.inputTokens);
    const outputEstimate = Math.min(this.reservation?.maxOutputTokens ?? Infinity, Math.ceil(this.unreportedChars / CHARS_PER_TOKEN));
    this.outputTokens += outputMissing ? outputEstimate : count(usage.outputTokens);
    this.hadEstimatedUsage ||= (inputMissing && this.pendingInputBound > 0) || (outputMissing && this.unreportedChars > 0);
    this.pendingInputBound = 0;
    this.cacheReadTokens += count(usage?.inputTokenDetails?.cacheReadTokens);
    this.cacheWriteTokens += count(usage?.inputTokenDetails?.cacheWriteTokens);
    if (responseId) this.providerResponseId = responseId;
    // Text streamed during this step is covered by its reported usage.
    this.unreportedChars = 0;
  }

  /** Streamed text or reasoning not yet covered by a reported step. */
  observeOutput(text: string): void {
    this.unreportedChars += text.length;
  }

  finish(outcome: LlmCallOutcome): LlmUsageEvent {
    const tenant = currentTenant();
    const estimatedOutput = Math.min(this.reservation?.maxOutputTokens ?? Infinity, Math.ceil(this.unreportedChars / CHARS_PER_TOKEN));
    return {
      tenantId: tenant?.tenantId ?? null,
      userId: tenant?.userId ?? null,
      requestId: currentRequestId() ?? null,
      ...this.call,
      inputTokens: this.inputTokens + this.pendingInputBound,
      outputTokens: this.outputTokens + estimatedOutput,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      steps: this.steps + (this.pendingInputBound > 0 ? 1 : 0),
      estimated: this.hadEstimatedUsage || estimatedOutput > 0 || this.pendingInputBound > 0,
      outcome,
      latencyMs: Date.now() - this.startedAt,
      providerResponseId: this.providerResponseId,
      priceTableVersion: this.reservation?.priceVersion ?? LLM_PRICE_TABLE_VERSION,
      ...(this.reservation ? { creditReservationId: this.reservation.id, creditPeriod: this.reservation.periodStart } : {}),
    };
  }
}

export type LlmUsageSink = (event: LlmUsageEvent) => Promise<void>;

/** The row inserted into public.llm_usage_events (tenant_id from its default). */
export function ledgerRow(event: LlmUsageEvent): Record<string, unknown> {
  return {
    user_id: event.userId,
    request_id: event.requestId,
    feature: event.feature,
    provider: event.provider,
    model: event.model,
    key_mode: event.keyMode,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_write_tokens: event.cacheWriteTokens,
    steps: event.steps,
    usage_estimated: event.estimated,
    outcome: event.outcome,
    latency_ms: event.latencyMs,
    provider_response_id: event.providerResponseId,
    price_table_version: event.priceTableVersion,
    ...(event.creditReservationId ? { credit_reservation_id: event.creditReservationId, credit_period: event.creditPeriod } : {}),
    completed_at: new Date().toISOString(),
  };
}

/** The production sink: one insert through the tenant-scoped client. */
export async function writeLlmUsageToLedger(event: LlmUsageEvent): Promise<void> {
  // Loaded on first use so suites that only exercise the LLM adapters do not
  // pull the database client in.
  const { createServerSupabase } = await import("../supabase.js");
  if (event.creditReservationId) {
    const { data, error } = await createServerSupabase().rpc("settle_tenant_credits", { p_id: event.creditReservationId, p_event: ledgerRow(event) });
    if (error) throw error;
    if ((data as { underestimated?: boolean } | null)?.underestimated) recordTenantMetric("tenant.credit_budget.reservation_underestimated");
    return;
  }
  const { error } = await createServerSupabase()
    .from("llm_usage_events")
    .insert(ledgerRow(event));
  if (error) throw error;
}

const discard: LlmUsageSink = async () => {};

function defaultSink(event: LlmUsageEvent): LlmUsageSink {
  return process.env.NODE_ENV === "test" && !event.creditReservationId ? discard : writeLlmUsageToLedger;
}

let sink: LlmUsageSink | null = null;
const pending = new Set<Promise<void>>();
let lastWarnedAt = 0;

/**
 * Replace the ledger writer (tests, and later issue 016's settle step);
 * `null` restores the default. Returns the previous override.
 */
export function setLlmUsageSink(next: LlmUsageSink | null): LlmUsageSink | null {
  const previous = sink;
  sink = next;
  return previous;
}

/** Record one call. Never throws and never delays the caller. */
export function recordLlmUsage(event: LlmUsageEvent): void {
  let write: Promise<void>;
  try {
    write = (sink ?? defaultSink(event))(event);
  } catch (error) {
    write = Promise.reject(error);
  }
  const tracked = write.catch((error: unknown) => {
    if (event.creditReservationId) recordTenantMetric("tenant.credit_budget.settlement_failed");
    const now = Date.now();
    if (now - lastWarnedAt < 60_000) return;
    lastWarnedAt = now;
    console.warn("[llm-usage] ledger write failed", safeErrorLog(error), {
      feature: event.feature,
      model: event.model,
    });
  });
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
  // Tokens-per-minute bucket (issue 017); a no-op unless configured.
  void chargeTenantLlmTokens(event.inputTokens + event.outputTokens);
}

/** Wait for in-flight ledger writes (tests, graceful shutdown). */
export async function flushLlmUsage(): Promise<void> {
  await Promise.all([...pending]);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Run one logical model call with a meter and record exactly one ledger row
 * for it, whether it completes, is aborted (recording what was produced) or
 * fails.
 */
export async function meterLlmCall<T>(
  call: LlmCallDescriptor,
  run: (meter: LlmUsageMeter) => Promise<T>,
  abortSignal?: AbortSignal,
  budgetRequest?: { prompt: unknown; maxOutputTokens?: number },
): Promise<T> {
  const reservation = budgetRequest ? await reserveTenantCredits(call, budgetRequest.prompt, budgetRequest.maxOutputTokens) : undefined;
  const meter = new LlmUsageMeter(call, reservation);
  try {
    const result = await run(meter);
    recordLlmUsage(meter.finish("completed"));
    return result;
  } catch (error) {
    recordLlmUsage(meter.finish(isAbort(error, abortSignal) ? "aborted" : "failed"));
    throw error;
  }
}
