// Boot-time proof that the document-lifecycle migration is applied.
//
// Rollouts run code and migrations at different moments, and this subsystem is
// asymmetric about which order is safe. Migration first is merely untidy: an
// older runner meets a job kind it does not know, fails the row, and the
// claim's backoff keeps it polite until the new code arrives. Code first is
// destructive in a way nothing reports: deletes still succeed, because the
// rows go through ordinary DELETEs — but the trigger that records WHERE the
// bytes live does not exist yet, so nothing is ever enqueued and the objects
// are orphaned with no record that they were meant to go. Uploads and edits
// 500 at the same time (PGRST202 on the lifecycle RPCs), which looks like an
// unrelated outage.
//
// So: ask the database once, at boot, whether the contract is installed, and
// refuse to serve if it is not. The check is a single cheap RPC.

import { createServerSupabase, type Db } from "../supabase";

export type LifecycleProbe = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

export type LifecycleVerdict =
  | { status: "ok" }
  | { status: "missing"; message: string }
  | { status: "inconclusive"; message: string };

/** PostgREST: the function is not in the schema cache. Postgres: no such function. */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

const ACTIONABLE = [
  "[startup] The document-lifecycle migration is not applied to this database.",
  "Deletes would succeed while the trigger that records their storage keys does",
  "not exist, orphaning objects with no record that they were meant to go, and",
  "every upload, version and edit would fail. Apply the migrations",
  "(backend/migrations, see docs/deployment.md) and restart. To start anyway —",
  "knowing storage will leak — set DOCUMENT_LIFECYCLE_GUARD=off.",
].join(" ");

/**
 * The contract version this build needs. 1 = the five lifecycle RPCs
 * (20260914_01); 2 = those plus `upload_session_files.document_created_at`
 * (20260916_01), which the upload worker stamps after every documents upsert
 * and treats a failed stamp as a failed upload. A database one version behind
 * would pass a "functions exist" probe and then fail every new-document
 * upload, so the probe has to be asked for the version the code was written
 * against, not merely whether the subsystem exists.
 */
export const REQUIRED_LIFECYCLE_VERSION = 2;

const BEHIND = [
  "[startup] The database is behind the document-lifecycle contract this build",
  `needs (found version %d, need ${REQUIRED_LIFECYCLE_VERSION}).`,
  "Every new-document upload would fail. Apply the newer migrations in",
  "backend/migrations (see docs/deployment.md) and restart. To start anyway,",
  "set DOCUMENT_LIFECYCLE_GUARD=off.",
].join(" ");

/**
 * The decision, separated from the call so it can be tested directly.
 *
 * An unknown error is inconclusive for one probe. The boot gate retries that
 * verdict, but never turns it into permission to serve: once the retry budget
 * is exhausted it fails closed because an unverified schema can orphan
 * document storage after the database recovers.
 */
export function evaluateLifecycleProbe(
  probe: LifecycleProbe,
): LifecycleVerdict {
  if (probe.error) {
    const code = probe.error.code ?? "";
    if (MISSING_FUNCTION_CODES.has(code))
      return { status: "missing", message: ACTIONABLE };
    return {
      status: "inconclusive",
      message: `[startup] Could not verify the document-lifecycle migration: ${
        probe.error.message ?? code ?? "unknown error"
      }`,
    };
  }
  // Number(null) is 0, and "0" is the answer that stops the process — so the
  // absence of an answer has to be ruled out before the value is read.
  const raw = Array.isArray(probe.data) ? probe.data[0] : probe.data;
  const version = typeof raw === "number" ? raw : Number.NaN;
  if (version >= REQUIRED_LIFECYCLE_VERSION) return { status: "ok" };
  if (version === 0) return { status: "missing", message: ACTIONABLE };
  if (version >= 1)
    return {
      status: "missing",
      message: BEHIND.replace("%d", String(version)),
    };
  return {
    status: "inconclusive",
    message:
      "[startup] Could not verify the document-lifecycle migration: the probe returned no version.",
  };
}

export async function probeDocumentLifecycle(
  db: Db,
): Promise<LifecycleVerdict> {
  try {
    const { data, error } = await db.rpc("document_lifecycle_version");
    return evaluateLifecycleProbe({ data, error });
  } catch (err) {
    return evaluateLifecycleProbe({
      data: null,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Boot gate. A temporarily unavailable database gets a short bounded retry
 * window. The process exits unless one probe proves that the required
 * contract is installed; serving after an inconclusive answer would make a
 * transient startup failure permanently bypass the lifecycle protection.
 */
const DEFAULT_PROBE_ATTEMPTS = 6;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;

type LifecycleGuardOptions = {
  attempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export async function enforceDocumentLifecycleMigration(
  db: Db = createServerSupabase(),
  exit: (code: number) => never = process.exit as (code: number) => never,
  options: LifecycleGuardOptions = {},
): Promise<LifecycleVerdict> {
  if (process.env.DOCUMENT_LIFECYCLE_GUARD === "off") return { status: "ok" };
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_PROBE_ATTEMPTS),
  );
  const sleep = options.sleep ?? wait;
  let verdict: LifecycleVerdict = {
    status: "inconclusive",
    message: "[startup] The document-lifecycle migration was not verified.",
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = await probeDocumentLifecycle(db);
    if (verdict.status === "ok") return verdict;
    if (verdict.status === "missing") break;
    if (attempt < attempts) {
      console.warn(`${verdict.message} Retrying (${attempt}/${attempts})...`);
      await sleep(
        Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS),
      );
    }
  }

  const message =
    verdict.status === "inconclusive"
      ? `${verdict.message} Refusing to start without confirming lifecycle contract version ${REQUIRED_LIFECYCLE_VERSION}.`
      : verdict.message;
  console.error(message);
  exit(1);
  return verdict;
}
