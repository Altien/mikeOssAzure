// An in-memory stand-in for the Supabase client that executes filters as
// well as recording writes, shared by the playbook module tests.
import { randomUUID } from "node:crypto";
import type { Db } from "../../../lib/supabase";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export type Row = Record<string, unknown>;

/** Execute filters as well as record writes, to exercise tenant isolation. */
export function database(
  rows: Row[],
  members: Row[] = [],
  profiles: Row[] = [],
  overrides: Row[] = [],
) {
  // A fixture's shared_with becomes viewer grants, as the 20261017_04
  // migration moved them.
  const shares = rows.flatMap((row) =>
    ((row.shared_with as string[] | undefined) ?? []).map((email) => ({
      id: `share-${row.id}-${email}`,
      playbook_id: row.id,
      shared_with_email: email,
      role: "viewer",
    })),
  );
  rows.forEach((row) => delete row.shared_with);
  const tables: Record<string, Row[]> = {
    playbooks: rows,
    playbook_shares: shares,
    playbook_org_access_overrides: overrides,
    org_members: members,
    user_profiles: profiles,
    organizations: [
      { id: ORG, kind: "team" },
      { id: OTHER, kind: "team" },
    ],
    playbook_runs: [],
  };
  const writes: { table: string; op: string; payload: Row }[] = [];
  const from = (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let op = "select";
    let payload: Row = {};
    let upserts: Row[] = [];
    let conflict: string[] = [];
    const settle = () => {
      let result = (tables[table] ?? []).filter((row) =>
        predicates.every((test) => test(row)),
      );
      if (op !== "select") {
        writes.push({ table, op, payload });
        if (op === "insert") {
          if (table === "db_jobs") payload = { id: randomUUID(), status: "pending", attempts: 0,
            created_at: new Date().toISOString(), claim_token: null, lease_expires_at: null, ...payload };
          (tables[table] ??= []).push(payload);
          result = [payload];
        }
        if (op === "update")
          result.forEach((row) => Object.assign(row, payload));
        if (op === "delete")
          tables[table] = (tables[table] ?? []).filter(
            (row) => !result.includes(row),
          );
        if (op === "upsert") {
          for (const value of upserts) {
            const existing = (tables[table] ??= []).find((row) =>
              conflict.every((key) => row[key] === value[key]),
            );
            if (existing) Object.assign(existing, value);
            else tables[table].push({ id: `${table}-${tables[table].length}`, ...value });
          }
          result = upserts;
        }
      }
      return { data: result, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        predicates.push((row) => row[key] === value);
        return query;
      },
      is: (key: string, value: unknown) => {
        if (!key.includes("."))
          predicates.push((row) => (row[key] ?? null) === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row[key]));
        return query;
      },
      lt: (key: string, value: unknown) => {
        predicates.push((row) => String(row[key]) < String(value));
        return query;
      },
      contains: (key: string, values: unknown[]) => {
        predicates.push((row) =>
          values.every((value) => (row[key] as unknown[]).includes(value)),
        );
        return query;
      },
      order: () => query,
      limit: () => query,
      insert: (value: Row) => {
        op = "insert";
        payload = value;
        return query;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      upsert: (values: Row[], options: { onConflict: string }) => {
        op = "upsert";
        upserts = values;
        payload = { rows: values.length };
        conflict = options.onConflict.split(",");
        return query;
      },
      single: async () => ({
        data: settle().data[0] ?? null,
        error: null,
      }),
      maybeSingle: async () => ({
        data: settle().data[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve),
    };
    return query;
  };

  // Model the canonical queue/domain transaction used by these unit tests.
  // PostgreSQL integration fixtures separately exercise the real locks/CAS.
  const rpcs: { name: string; args: Row }[] = [];
  const rpc = async (name: string, args: Row) => {
    rpcs.push({ name, args });
    const result = (data: unknown) => ({ data, error: null });
    const jobs = tables.db_jobs ?? [];
    const job = jobs.find((row) => row.id === (args.p_job_id ?? args.p_id));
    if (!job) return result(name === "claim_db_job" ? [] : name === "mutate_playbook_job" ? { result: "stale" } : false);
    const matches = job.attempts === (args.p_attempt ?? args.p_attempts)
      && job.claim_token === (args.p_token ?? args.p_claim_token);
    const live = matches && job.status === "running"
      && Date.parse(String(job.lease_expires_at)) > Date.now();
    if (name === "claim_db_job") {
      if (!job || job.status !== "pending") return result([]);
      Object.assign(job, { status: "running", attempts: Number(job.attempts ?? 0) + 1,
        claim_token: randomUUID(), claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 300_000).toISOString() });
      return result([{ ...job }]);
    }
    if (name === "renew_db_job") return result(live);
    if (name === "finish_db_job" || name === "defer_db_job") {
      if (!live) return result(false);
      Object.assign(job, { status: name === "defer_db_job" ? "pending" : args.p_status,
        lease_expires_at: null, last_error: args.p_last_error ?? args.p_reason ?? null,
        result: args.p_result ?? null });
      if (name === "defer_db_job") job.attempts = Number(job.attempts) - 1;
      return result(true);
    }
    if (name !== "mutate_playbook_job") throw new Error("Unexpected fixture RPC: " + name);
    if (!(args.p_terminal ? matches && job.status === "failed" : live)) return result({ result: "stale" });
    const payload = job.payload as Row;
    const importing = job.kind === "playbook.import";
    const table = importing ? "playbook_imports" : "playbook_runs";
    const domain = (tables[table] ?? []).find((row) => row.id === args.p_domain_id && row.user_id === payload.userId);
    if (!domain || (importing ? payload.attemptId : payload.runId) !== domain.id) return result({ result: "stale" });
    const operation = args.p_operation;
    if (args.p_terminal && operation !== "failure" && operation !== "check") return result({ result: "stale" });
    if (operation === "check") return result({ result: "current" });
    if (domain.status !== "running") return result({ result: "settled" });
    const values = (args.p_values ?? {}) as Row;
    const snapshotOrg = payload.orgId ?? null;
    const bookId = importing ? payload.replacePlaybookId : domain.playbook_id;
    const book = tables.playbooks.find((row) => row.id === bookId);
    const action = importing ? (bookId ? "playbook.replaced" : "playbook.imported") : "playbook.run";
    const detail: Row = importing
      ? { import_id: domain.id, playbook_id: bookId ?? null }
      : { playbook_id: bookId, run_id: domain.id, scope: domain.review_scope, posture: domain.review_mode };
    const audit = (status: string) => (tables.audit_events ??= []).push({
      user_id: payload.userId, user_email: payload.userEmail, org_id: snapshotOrg,
      action, status, surface: "playbooks", model: domain.model,
      title: values.name ?? (domain.content_json as Row | undefined)?.name ?? domain.filename,
      document_id: domain.document_id ?? null, detail: { ...detail },
    });
    const update = (value: Row) => { Object.assign(domain, value, { updated_at: new Date().toISOString() });
      writes.push({ table, op: "update", payload: value }); };
    if (["heartbeat", "import_progress", "failure"].includes(String(operation))) {
      const failed = operation === "failure" || values.status === "failed";
      update({ ...values, ...(failed ? { status: "failed", completed_at: new Date().toISOString() } : {}) });
      if (failed) { if (importing) detail.stage = values.stage ?? domain.stage; audit("failed"); }
      return result({ result: "updated" });
    }
    const member = (tables.org_members ?? []).find((row) => row.org_id === snapshotOrg && row.user_id === payload.userId);
    if (snapshotOrg && !member) return result({ result: "forbidden" });
    if (bookId) {
      if (!book || (book.org_id ?? null) !== snapshotOrg) return result({ result: "forbidden" });
      const override = (tables.playbook_org_access_overrides ?? []).find((row) => row.playbook_id === book.id && row.org_id === snapshotOrg && row.user_id === payload.userId);
      const share = (tables.playbook_shares ?? []).find((row) => row.playbook_id === book.id && String(row.shared_with_email).toLowerCase() === String(payload.userEmail).toLowerCase());
      const role = book.user_id === payload.userId ? "owner" : snapshotOrg
        ? member?.role === "owner" && book.visibility === "organization" ? "owner"
          : override?.role === "deny" ? null : override?.role ?? (book.visibility === "organization" ? "viewer" : null)
        : share?.role;
      if (!role || (importing && !["owner", "editor"].includes(String(role)))) return result({ result: "forbidden" });
    }
    if (!importing && domain.document_id) {
      const document = (tables.documents ?? []).find((row) => row.id === domain.document_id && !row.archived_at);
      const expected = payload.expectedVersion as Row | null;
      const placement = document?.project_id ? (tables.projects ?? []).find((row) => row.id === document.project_id)?.org_id
        : document?.workflow_id ? (tables.workflows ?? []).find((row) => row.id === document.workflow_id)?.org_id : document?.org_id;
      if (!document || document.user_id !== payload.userId || (placement ?? null) !== snapshotOrg) return result({ result: "forbidden" });
      if (expected?.id && document.current_version_id !== (values.edited_version_id ?? expected.id)) return result({ result: "conflict" });
    }
    if (operation === "import_publish") {
      if (bookId) {
        if (!domain.target_updated_at || !payload.targetUpdatedAt || domain.target_updated_at !== payload.targetUpdatedAt
          || book!.updated_at !== domain.target_updated_at || values.id !== bookId) return result({ result: "conflict" });
        Object.assign(book!, values, { updated_at: new Date().toISOString() });
      } else {
        if (!payload.newPlaybookId || values.id !== payload.newPlaybookId) return result({ result: "stale" });
        tables.playbooks.push({ ...values, user_id: payload.userId, org_id: snapshotOrg, updated_at: new Date().toISOString() });
      }
      detail.playbook_id = bookId ?? payload.newPlaybookId;
      update({ status: "completed", stage: "completed", playbook_id: detail.playbook_id, error: null });
      audit("completed"); return result({ result: "published", id: detail.playbook_id });
    }
    if (operation === "review_publish") {
      const outcomes: Record<string, number> = {};
      for (const finding of (values.findings_json ?? []) as Row[]) outcomes[String(finding.status)] = (outcomes[String(finding.status)] ?? 0) + 1;
      detail.outcomes = outcomes; update({ ...values, status: "completed", error: null }); audit("completed");
      return result({ result: "published" });
    }
    return result({ result: "stale" });
  };

  return { db: { from, rpc } as unknown as Db, writes, tables, rpcs };
}
