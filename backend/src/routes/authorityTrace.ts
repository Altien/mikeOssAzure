import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { checkProjectAccess } from "../lib/access";
import {
  getCitationVerificationRun,
} from "../lib/citationVerification/service";
import { createServerSupabase } from "../lib/supabase";

export const authorityTraceRouter = Router();

authorityTraceRouter.use(requireAuth);

authorityTraceRouter.get("/runs/:runId", async (req, res) => {
  try {
    const db = createServerSupabase();
    const run = await getCitationVerificationRun(req.params.runId, db);
    if (!run) {
      return res.status(404).json({ detail: "Verification run not found" });
    }

    const access = await checkProjectAccess(
      run.project_id,
      String(res.locals.userId ?? ""),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return res.status(404).json({ detail: "Verification run not found" });
    }

    return res.json(run);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "Failed to load verification run";
    return res.status(500).json({ detail });
  }
});
