import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { tenantAdminStatus, tenantAdminOverview, tenantAdminContent, reassignTenantContent } from "./tenant-admin.service";

export const tenantAdminRouter = Router();
tenantAdminRouter.use(requireAuth);
tenantAdminRouter.get("/status", (_req, res) => { res.json(tenantAdminStatus()); });
tenantAdminRouter.get("/overview", async (_req, res) => {
  const result = await tenantAdminOverview(createServerSupabase());
  if (!result.ok) { sendServiceFailure(res, result); return; }
  res.json(result.data);
});
tenantAdminRouter.get("/content", async (req, res) => {
  const result = await tenantAdminContent(createServerSupabase(), {
    kind: typeof req.query.kind === "string" ? req.query.kind : "project",
    offset: Number(req.query.offset ?? 0), limit: Number(req.query.limit ?? 50),
  });
  if (!result.ok) { sendServiceFailure(res, result); return; }
  res.json(result.data);
});
tenantAdminRouter.post("/reassign", async (req, res) => {
  const result = await reassignTenantContent(createServerSupabase(), {
    kind: req.body?.kind, id: req.body?.id, newOwnerId: req.body?.newOwnerId, reason: req.body?.reason,
  });
  if (!result.ok) { sendServiceFailure(res, result); return; }
  res.json(result.data);
});
