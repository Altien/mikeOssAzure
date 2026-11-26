// HTTP layer for the support module: report an issue with one assistant
// response, and withdraw that report. Handlers read the caller off
// res.locals and map the service results onto status codes.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  createSupportReport,
  isUuid,
  withdrawSupportReport,
} from "./support.service";

export const supportRouter = Router();

supportRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await createSupportReport(createServerSupabase(), {
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

supportRouter.post(
  "/:reportId/withdraw",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.reportId))
      return void res.status(404).json({ detail: "Report not found" });
    const result = await withdrawSupportReport(createServerSupabase(), {
      userId: res.locals.userId as string,
      reportId: req.params.reportId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

supportRouter.use(routerErrorHandler("[support]"));
