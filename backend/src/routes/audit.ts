// Audit history — GET /audit (JSON, paginated) + GET /audit/export (CSV).
// Visibility: the caller's own events, plus events in projects they own or
// that are shared with their email.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const auditRouter = Router();
auditRouter.use(requireAuth);

const PAGE_SIZE = 50;
const EXPORT_LIMIT = 2000;

async function accessibleProjectIds(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  email: string | undefined,
): Promise<string[]> {
  const ids = new Set<string>();
  const own = await db.from("projects").select("id").eq("user_id", userId);
  for (const row of (own.data ?? []) as { id: string }[]) ids.add(row.id);
  if (email) {
    const shared = await db
      .from("projects")
      .select("id")
      .contains("shared_with", [email]);
    for (const row of (shared.data ?? []) as { id: string }[]) ids.add(row.id);
  }
  return [...ids];
}

type AuditQuery = {
  q?: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
};

function parseQuery(raw: Record<string, unknown>, limit: number): AuditQuery {
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const page = Math.max(Number.parseInt(String(raw.page ?? "1"), 10) || 1, 1);
  return {
    q: str(raw.q)?.slice(0, 200),
    action: str(raw.action)?.slice(0, 60),
    from: str(raw.from),
    to: str(raw.to),
    page,
    limit,
  };
}

async function queryEvents(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  email: string | undefined,
  q: AuditQuery,
) {
  const projectIds = await accessibleProjectIds(db, userId, email);
  let query = db
    .from("audit_events")
    .select(
      "id, created_at, user_email, action, status, title, surface, project_id, chat_id, document_id, review_id, model, detail",
      { count: "exact" },
    );
  query = projectIds.length
    ? query.or(
        `user_id.eq.${userId},project_id.in.(${projectIds.join(",")})`,
      )
    : query.eq("user_id", userId);
  if (q.action) query = query.eq("action", q.action);
  if (q.q) query = query.ilike("title", `%${q.q.replace(/[%_]/g, "\\$&")}%`);
  if (q.from) query = query.gte("created_at", q.from);
  if (q.to) query = query.lte("created_at", `${q.to}T23:59:59.999Z`);
  return query
    .order("created_at", { ascending: false })
    .range((q.page - 1) * q.limit, q.page * q.limit - 1);
}

auditRouter.get("/", async (req, res) => {
  const userId = res.locals.userId as string;
  const email = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const q = parseQuery(req.query as Record<string, unknown>, PAGE_SIZE);
  const { data, error, count } = await queryEvents(db, userId, email, q);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ events: data ?? [], total: count ?? 0, page: q.page, pageSize: PAGE_SIZE });
});

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

auditRouter.get("/export", async (req, res) => {
  const userId = res.locals.userId as string;
  const email = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const q = parseQuery(req.query as Record<string, unknown>, EXPORT_LIMIT);
  q.page = 1;
  const { data, error } = await queryEvents(db, userId, email, q);
  if (error) return void res.status(500).json({ detail: error.message });
  const header = "created_at,user,action,status,title,application,project_id,model";
  const rows = ((data ?? []) as Record<string, unknown>[]).map((e) =>
    [
      e.created_at,
      e.user_email,
      e.action,
      e.status,
      e.title,
      e.surface,
      e.project_id,
      e.model,
    ]
      .map(csvCell)
      .join(","),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="history-export.csv"',
  );
  res.send([header, ...rows].join("\n"));
});
