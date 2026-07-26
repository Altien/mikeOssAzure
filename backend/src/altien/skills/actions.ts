import { createHash, randomUUID } from "node:crypto";

export type PendingSkillAction = {
  id: string;
  actionType: "enable_version" | "disable_version" | "approve_contract";
  payload: Record<string, unknown>;
  payloadHash: string;
  state: "pending";
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashActionPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function createEnableAction(args: {
  versionId: string;
  analysisInputHash: string;
  executionContract: Record<string, unknown>;
}): PendingSkillAction {
  const payload = {
    versionId: args.versionId,
    analysisInputHash: args.analysisInputHash,
    executionContract: args.executionContract,
  };
  return {
    id: randomUUID(),
    actionType: "enable_version",
    payload,
    payloadHash: hashActionPayload(payload),
    state: "pending",
  };
}

export function isAffirmativeAuthorization(message: string): boolean {
  return /^(yes|approve|authorise|authorize|enable|enable it|approve it)[.!]?$/i.test(
    message.trim(),
  );
}

export function isRejection(message: string): boolean {
  return /^(no|reject|cancel|do not enable|don't enable)[.!]?$/i.test(
    message.trim(),
  );
}

export function assertActionIntegrity(action: {
  payload: Record<string, unknown>;
  payloadHash: string;
}) {
  if (hashActionPayload(action.payload) !== action.payloadHash) {
    throw new Error("Pending action payload hash mismatch.");
  }
}
