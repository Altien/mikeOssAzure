import { createHash, randomUUID } from "node:crypto";

export type PendingSkillAction = {
  id: string;
  actionType:
    | "enable_version"
    | "disable_version"
    | "approve_contract"
    | "link_prior_skill"
    | "rename_skill"
    | "acquire_dependency";
  payload: Record<string, unknown>;
  payloadHash: string;
  state: "pending";
};

/**
 * Canonical form must survive a jsonb round-trip unchanged, because an action
 * payload is hashed when it is proposed and re-hashed after being read back
 * from the database. `undefined` is not JSON: storage drops an
 * undefined-valued key and turns an undefined array element into `null`, so
 * canonicalization does exactly the same rather than emitting an `undefined`
 * token that could never be reproduced from the stored row.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
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
  /**
   * Hash of the generated analysis this contract was derived from. The input
   * hash covers only the package text, so it is identical across a re-analysis
   * with a different model; without this a contract reviewed under one model
   * would still pass integrity against another model's findings.
   */
  analysisOutputHash: string;
  executionContract: Record<string, unknown>;
  /**
   * References the fast model could not resolve in the package text. They
   * grant nothing, but the administrator approves them as reviewed facts, so
   * a re-analysis that changes them invalidates the hash.
   */
  unresolvedReferences?: readonly string[];
  /**
   * Set when this action replaces an amended one. The hash therefore covers
   * the amendment lineage as well as the amended contract.
   */
  amendedFromActionId?: string;
}): PendingSkillAction {
  const payload = {
    versionId: args.versionId,
    analysisInputHash: args.analysisInputHash,
    analysisOutputHash: args.analysisOutputHash,
    executionContract: args.executionContract,
    ...(args.unresolvedReferences?.length
      ? { unresolvedReferences: [...args.unresolvedReferences] }
      : {}),
    ...(args.amendedFromActionId
      ? { amendedFromActionId: args.amendedFromActionId }
      : {}),
  };
  return {
    id: randomUUID(),
    actionType: "enable_version",
    payload,
    payloadHash: hashActionPayload(payload),
    state: "pending",
  };
}

/**
 * A rename amendment cannot be folded into an enable action: renaming a draft
 * rewrites its adapted tree and resets analysis, which invalidates the very
 * analysis hash the enable payload is bound to. It therefore supersedes the
 * enable proposal with its own exact payload.
 */
export function createRenameSkillAction(args: {
  versionId: string;
  currentDisplayName: string;
  newDisplayName: string;
  amendedFromActionId?: string;
}): PendingSkillAction {
  const payload = {
    versionId: args.versionId,
    currentDisplayName: args.currentDisplayName,
    newDisplayName: args.newDisplayName,
    ...(args.amendedFromActionId
      ? { amendedFromActionId: args.amendedFromActionId }
      : {}),
  };
  return {
    id: randomUUID(),
    actionType: "rename_skill",
    payload,
    payloadHash: hashActionPayload(payload),
    state: "pending",
  };
}

/**
 * Story 38: a declared `github.com` dependency URL is a proposal, never an
 * instruction. The administrator authorizes this exact repository/ref payload
 * before the ordinary gated acquisition service is called.
 */
export function createAcquireDependencyAction(args: {
  versionId: string;
  dependencyName: string;
  url: string;
  owner: string;
  repository: string;
  ref: string | null;
  path: string | null;
}): PendingSkillAction {
  const payload = {
    versionId: args.versionId,
    dependencyName: args.dependencyName,
    url: args.url,
    owner: args.owner,
    repository: args.repository,
    ref: args.ref,
    path: args.path,
  };
  return {
    id: randomUUID(),
    actionType: "acquire_dependency",
    payload,
    payloadHash: hashActionPayload(payload),
    state: "pending",
  };
}

/**
 * One amendment directive. Amendments are parsed from an explicit command
 * syntax rather than free text: the selection they carry is security-relevant,
 * so it must never depend on model interpretation.
 */
export type SkillActionAmendment =
  | { kind: "restrict_tools"; toolNames: string[] }
  | { kind: "select_capability"; requirementName: string; toolNames: string[] }
  | { kind: "reject_capability"; requirementName: string }
  | { kind: "rename"; displayName: string };

/** Advertised verbatim by every proposal message. */
export const SKILL_AMENDMENT_SYNTAX = [
  "amend tools <tool>[,<tool>…]",
  "amend allow <requirement> => <tool>[,<tool>…]",
  "amend reject <requirement>",
  "amend rename <new display name>",
].join(" · ");

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function amendmentError(): never {
  throw new Error(
    `Unrecognised amendment. Use one directive per line: ${SKILL_AMENDMENT_SYNTAX}`,
  );
}

function toolList(raw: string): string[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length || names.length > 40) amendmentError();
  for (const name of names) {
    if (!TOOL_NAME.test(name)) amendmentError();
  }
  return Array.from(new Set(names));
}

function requirementName(raw: string): string {
  const name = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!name || name.length > 128) amendmentError();
  return name;
}

/**
 * Returns `null` when the message is not an amendment at all, so ordinary
 * review conversation is unaffected. Throws on a malformed directive rather
 * than silently applying part of one.
 */
export function parseSkillActionAmendments(
  message: string,
): SkillActionAmendment[] | null {
  const trimmed = message.trim();
  if (!/^amend\b/i.test(trimmed)) return null;
  const directives = trimmed
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!directives.length || directives.length > 20) amendmentError();
  const amendments = directives.map((directive): SkillActionAmendment => {
    const match = /^amend\s+(tools|allow|reject|rename)\b\s*(.*)$/i.exec(
      directive,
    );
    if (!match) amendmentError();
    const verb = match[1].toLowerCase();
    const rest = match[2] ?? "";
    if (verb === "tools") {
      return { kind: "restrict_tools", toolNames: toolList(rest) };
    }
    if (verb === "allow") {
      const parts = rest.split("=>");
      if (parts.length !== 2) amendmentError();
      return {
        kind: "select_capability",
        requirementName: requirementName(parts[0]),
        toolNames: toolList(parts[1]),
      };
    }
    if (verb === "reject") {
      return { kind: "reject_capability", requirementName: requirementName(rest) };
    }
    const displayName = rest.trim();
    if (!displayName || displayName.length > 128) amendmentError();
    return { kind: "rename", displayName };
  });
  if (amendments.filter((item) => item.kind === "rename").length > 1) {
    throw new Error("Only one rename amendment may be issued at a time.");
  }
  if (amendments.filter((item) => item.kind === "restrict_tools").length > 1) {
    throw new Error("Only one tool-set restriction may be issued at a time.");
  }
  return amendments;
}

/**
 * Import identity that was only suggested by weak evidence (declared name, or
 * a matching ZIP filename and entrypoint set) is never applied silently. The
 * administrator authorizes this exact payload to make the draft a new version
 * of the named prior skill instead of a separate one.
 */
export function createLinkPriorSkillAction(args: {
  versionId: string;
  currentSkillId: string;
  priorSkillId: string;
  priorCanonicalName: string;
  matchedOn: string;
  contentHash: string;
}): PendingSkillAction {
  const payload = {
    versionId: args.versionId,
    currentSkillId: args.currentSkillId,
    priorSkillId: args.priorSkillId,
    priorCanonicalName: args.priorCanonicalName,
    matchedOn: args.matchedOn,
    contentHash: args.contentHash,
  };
  return {
    id: randomUUID(),
    actionType: "link_prior_skill",
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
