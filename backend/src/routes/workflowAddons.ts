import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  downloadFile,
  uploadFile,
  workflowReferenceKey,
} from "../lib/storage";
import { enqueueStorageCleanup } from "../lib/dbq/enqueue";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { contentSha256 } from "../lib/documentVersions";
import { sendInternalError } from "../lib/httpError";

export const workflowAddonsRouter = Router();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

workflowAddonsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const type = typeof req.query.type === "string" ? req.query.type : null;
    let query = db
      .from("mike_workflows")
      .select(
        "id, workflow_key, pack_key, pack_title, pack_description, pack_version, version, title, description, type, contributors, language, practice, jurisdictions, active, updated_at",
      )
      .eq("distribution", "addon")
      .eq("active", true);
    if (type === "assistant" || type === "tabular")
      query = query.eq("type", type);
    const { data, error } = await query.order("title", { ascending: true });
    if (error) return void sendInternalError(res, error);
    res.json(
      (data ?? []).map(({ workflow_key, ...addon }) => ({
        ...addon,
        addon_key: workflow_key,
      })),
    );
  }),
);

workflowAddonsRouter.get(
  "/:addonId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("mike_workflows")
      .select("*")
      .eq("id", req.params.addonId)
      .eq("distribution", "addon")
      .eq("active", true)
      .maybeSingle();
    if (error || !data) {
      return void res.status(404).json({ detail: "Add-on not found" });
    }
    let references = null;
    if (data.type === "assistant") {
      const { data: assistantReferences, error: referencesError } = await db
        .from("mike_workflow_reference_files")
        .select("id, filename, file_type, size_bytes, created_at")
        .eq("mike_workflow_id", data.id)
        .order("created_at", { ascending: true });
      if (referencesError) {
        return void sendInternalError(res, referencesError);
      }
      references = assistantReferences;
    }
    const { workflow_key, ...addon } = data;
    res.json({
      ...addon,
      addon_key: workflow_key,
      reference_files: references ?? [],
    });
  }),
);

workflowAddonsRouter.post(
  "/:addonId/import",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data: addon } = await db
      .from("mike_workflows")
      .select("*")
      .eq("id", req.params.addonId)
      .eq("distribution", "addon")
      .eq("active", true)
      .maybeSingle();
    if (!addon)
      return void res.status(404).json({ detail: "Add-on not found" });

    const { data: workflow, error } = await db
      .from("workflows")
      .insert({
        user_id: userId,
        title: addon.title,
        type: addon.type,
        prompt_md: addon.prompt_md,
        columns_config: addon.columns_config,
        // Catalog rows may omit these; fall back to the workflows
        // column defaults rather than inserting explicit nulls.
        language: addon.language ?? "English",
        practice: addon.practice ?? "General Transactions",
        jurisdictions: addon.jurisdictions ?? ["General"],
      })
      .select("*")
      .single();
    if (error || !workflow) {
      return void sendInternalError(
        res,
        error ?? new Error("Workflow add-on import returned no data"),
      );
    }

    const createdStoragePaths: string[] = [];
    try {
      const { data: references, error: referencesError } =
        addon.type === "assistant"
          ? await db
              .from("mike_workflow_reference_files")
              .select("filename, file_type, storage_path, size_bytes")
              .eq("mike_workflow_id", addon.id)
              .order("created_at", { ascending: true })
          : { data: [], error: null };
      if (referencesError) throw referencesError;
      for (const reference of references ?? []) {
        const bytes = await downloadFile(reference.storage_path);
        if (!bytes)
          throw new Error(
            `Reference file '${reference.filename}' is unavailable`,
          );
        const referenceId = crypto.randomUUID();
        const contentHash = contentSha256(bytes);
        const sourcePath = workflowReferenceKey(
          userId,
          workflow.id,
          referenceId,
          contentHash,
          reference.filename,
        );
        await uploadFile(
          sourcePath,
          bytes,
          contentTypeForDocumentType(reference.file_type),
        );
        createdStoragePaths.push(sourcePath);
        const { error: referenceError } = await db
          .from("workflow_reference_documents")
          .insert({
            id: referenceId,
            workflow_id: workflow.id,
            user_id: userId,
            filename: reference.filename,
            file_type: reference.file_type,
            storage_path: sourcePath,
            size_bytes: reference.size_bytes ?? bytes.byteLength,
            content_hash: contentHash,
          });
        if (referenceError) throw referenceError;
      }
    } catch (referenceError) {
      // Rollback order matters: drop the workflow row first, so nothing can
      // reference the half-made copies, then hand the object deletes to the
      // durable storage.cleanup job. The previous Promise.all of best-effort
      // deletes died with the request — a restart mid-loop, or a single
      // storage error, leaked every copy made so far with no row left
      // pointing at them. The job retries until they are actually gone.
      await db
        .from("workflows")
        .delete()
        .eq("id", workflow.id)
        .eq("user_id", userId);
      await enqueueStorageCleanup(db, createdStoragePaths);
      return void res.status(500).json({
        detail:
          referenceError instanceof Error
            ? referenceError.message
            : "Failed to copy add-on reference files",
      });
    }

    res.status(201).json({
      id: workflow.id,
      user_id: workflow.user_id,
      metadata: {
        title: workflow.title,
        description: null,
        type: workflow.type,
        contributors: [],
        language: workflow.language ?? "English",
        version: null,
        practice: workflow.practice ?? null,
        jurisdictions: workflow.jurisdictions ?? null,
      },
      skill_md: workflow.prompt_md ?? null,
      columns_config: workflow.columns_config ?? null,
      is_system: false,
      is_owner: true,
      allow_edit: true,
      created_at: workflow.created_at,
    });
  }),
);

workflowAddonsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflow-addons] unhandled route error", err);
    res
      .status(500)
      .json({ detail: "Failed to process workflow add-on request" });
  },
);
