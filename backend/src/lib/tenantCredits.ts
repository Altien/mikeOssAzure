import { randomUUID } from "node:crypto";
import { currentTenant } from "./tenantContext";
import { getTenancyMode } from "./tenancyMode";
import { UserFacingError } from "./safeError";
import { recordTenantMetric } from "./tenantMetrics";
import type { LlmCallDescriptor } from "./llm/usage";

export class TenantBudgetError extends UserFacingError {
  readonly code: "tenant_budget_exhausted" | "tenant_budget_unavailable";
  readonly status: number;
  constructor(reason: string) {
    const exhausted = reason === "exhausted";
    super(exhausted
      ? "Your organisation has reached its monthly credit budget or your personal credit cap. Ask an administrator to review your allowance."
      : "Your organisation's credit budget is not available. Ask an administrator to check its budget and published model prices.");
    this.name = "TenantBudgetError";
    this.code = exhausted ? "tenant_budget_exhausted" : "tenant_budget_unavailable";
    this.status = exhausted ? 402 : 503;
  }
}

/**
 * Conservative text-prompt bound, including schemas, role/framing allowance
 * and escaped JSON. Unlike chars/4 this does not underestimate UTF-8 text or
 * tool results. Recomputed from the SDK's actual messages before every step.
 * All credit multiplication and comparison remains PostgreSQL numeric.
 */
export function promptTokenBound(prompt: unknown): number {
  const encoded = JSON.stringify(prompt) ?? "";
  const value = Buffer.byteLength(encoded, "utf8") * 2 + 1024;
  if (!Number.isSafeInteger(value)) throw new TenantBudgetError("invalid_prompt");
  return value;
}

type Admission = {
  allowed?: boolean; reason?: string; id?: string; price_version?: string;
  period_start?: string; max_output_tokens?: number; warning?: boolean;
};
async function creditRpc(name: string, args: Record<string, unknown>): Promise<Admission> {
  try {
    const { createServerSupabase } = await import("./supabase.js");
    const { data, error } = await createServerSupabase().rpc(name, args);
    if (error) throw error;
    const result = (Array.isArray(data) ? data[0] : data) as Admission | null;
    if (!result || result.allowed !== true) throw new TenantBudgetError(result?.reason ?? "unavailable");
    return result;
  } catch (error) {
    if (error instanceof TenantBudgetError) throw error;
    recordTenantMetric("tenant.credit_budget.admission_failed");
    throw new TenantBudgetError("unavailable");
  }
}

export class TenantCreditReservation {
  private nextStep = 0;
  constructor(
    readonly id: string,
    readonly priceVersion: string,
    readonly periodStart: string,
    readonly maxOutputTokens: number,
  ) {}
  async beforeStep(prompt: unknown): Promise<number> {
    const inputTokens = promptTokenBound(prompt);
    await creditRpc("top_up_tenant_credits", { p_id: this.id, p_step: this.nextStep, p_input_tokens: inputTokens });
    this.nextStep++;
    return inputTokens;
  }
}

/**
 * Single installs and BYO retain the existing no-credit-DB-call path. A
 * pooled platform-key call with no tenant has no budget to charge and fails
 * closed rather than run unmetered.
 */
export async function reserveTenantCredits(
  call: LlmCallDescriptor,
  prompt: unknown,
  maxOutputTokens?: number,
): Promise<TenantCreditReservation | undefined> {
  if (call.keyMode === "byo") return undefined;
  try {
    if (await getTenancyMode() === "single") return undefined;
  } catch {
    throw new TenantBudgetError("unavailable");
  }
  if (!currentTenant()) {
    recordTenantMetric("tenant.credit_budget.no_tenant");
    throw new TenantBudgetError("unavailable");
  }
  const id = randomUUID();
  const result = await creditRpc("reserve_tenant_credits", {
    p_id: id, p_provider: call.provider, p_model: call.model,
    p_input_tokens: promptTokenBound(prompt), p_output_tokens: maxOutputTokens ?? null,
  });
  if (typeof result.price_version !== "string" || typeof result.period_start !== "string" ||
    !Number.isSafeInteger(result.max_output_tokens) || !(result.max_output_tokens! > 0)) {
    throw new TenantBudgetError("unavailable");
  }
  if (result.warning) recordTenantMetric("tenant.credit_budget.soft_warning");
  return new TenantCreditReservation(id, result.price_version, result.period_start, result.max_output_tokens!);
}
