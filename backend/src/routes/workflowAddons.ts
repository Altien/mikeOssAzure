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
  storageKey,
  uploadFile,
} from "../lib/storage";
import { enqueueStorageCleanup } from "../lib/dbq/enqueue";
import {
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../lib/documentTypes";
import { contentSha256 } from "../lib/documentVersions";
import { sendInternalError } from "../lib/httpError";
import { convertedPdfKey } from "../lib/convert";
import {
  loadDocumentDisplay,
  prepareDocumentDisplay,
  sendDocumentDisplay,
} from "../lib/documentDisplay";

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
    const addons = data ?? [];
    const assistantIds = addons
      .filter((addon) => addon.type === "assistant")
      .map((addon) => addon.id);
    const { data: assets, error: assetsError } =
      assistantIds.length > 0
        ? await db
            .from("mike_workflow_assets")
            .select(
              "id, mike_workflow_id, filename, file_type, size_bytes, created_at",
            )
            .in("mike_workflow_id", assistantIds)
            .order("created_at", { ascending: true })
        : { data: [], error: null };
    if (assetsError) return void sendInternalError(res, assetsError);
    const assetsByAddon = new Map<string, typeof assets>();
    for (const asset of assets ?? []) {
      const current = assetsByAddon.get(asset.mike_workflow_id) ?? [];
      current.push(asset);
      assetsByAddon.set(asset.mike_workflow_id, current);
    }
    res.json(
      addons.map(({ workflow_key, ...addon }) => ({
        ...addon,
        addon_key: workflow_key,
        assets: (assetsByAddon.get(addon.id) ?? []).map(
          ({ mike_workflow_id: _workflowId, ...asset }) => asset,
        ),
      })),
    );
  }),
);

workflowAddonsRouter.get(
  "/:addonId/assets/:assetId/display",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const { data: addon, error: addonError } = await db
      .from("mike_workflows")
      .select("id, type")
      .eq("id", req.params.addonId)
      .eq("distribution", "addon")
      .eq("active", true)
      .maybeSingle();
    if (addonError) return void sendInternalError(res, addonError);
    if (!addon || addon.type !== "assistant") {
      return void res.status(404).json({ detail: "Add-on not found" });
    }

    const { data: asset, error: assetError } = await db
      .from("mike_workflow_assets")
      .select("id, filename, file_type, storage_path")
      .eq("id", req.params.assetId)
      .eq("mike_workflow_id", addon.id)
      .maybeSingle();
    if (assetError) return void sendInternalError(res, assetError);
    if (!asset) {
      return void res.status(404).json({ detail: "Asset not found" });
    }

    try {
      const display = await loadDocumentDisplay({
        filename: asset.filename,
        fileType: asset.file_type,
        storagePath: asset.storage_path,
      });
      if (!display) {
        return void res
          .status(404)
          .json({ detail: "Asset not found in storage" });
      }
      sendDocumentDisplay(res, display);
    } catch (error) {
      return void sendInternalError(res, error);
    }
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
    let assets = null;
    if (data.type === "assistant") {
      const { data: assistantAssets, error: assetsError } = await db
        .from("mike_workflow_assets")
        .select("id, filename, file_type, size_bytes, created_at")
        .eq("mike_workflow_id", data.id)
        .order("created_at", { ascending: true });
      if (assetsError) {
        return void sendInternalError(res, assetsError);
      }
      assets = assistantAssets;
    }
    const { workflow_key, ...addon } = data;
    res.json({
      ...addon,
      addon_key: workflow_key,
      assets: assets ?? [],
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
      const { data: assets, error: assetsError } =
        addon.type === "assistant"
          ? await db
              .from("mike_workflow_assets")
              .select("filename, file_type, storage_path, size_bytes")
              .eq("mike_workflow_id", addon.id)
              .order("created_at", { ascending: true })
          : { data: [], error: null };
      if (assetsError) throw assetsError;
      for (const asset of assets ?? []) {
        const bytes = await downloadFile(asset.storage_path);
        if (!bytes) throw new Error(`Asset '${asset.filename}' is unavailable`);
        const documentId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const contentHash = contentSha256(bytes);
        const sourcePath = storageKey(userId, documentId, asset.filename);
        await uploadFile(
          sourcePath,
          bytes,
          contentTypeForDocumentType(asset.file_type),
        );
        createdStoragePaths.push(sourcePath);
        let pdfStoragePath: string | null = null;
        if (shouldConvertToPdf(asset.file_type)) {
          const display = await prepareDocumentDisplay({
            filename: asset.filename,
            fileType: asset.file_type,
            sourceBytes: bytes,
          });
          pdfStoragePath = convertedPdfKey(userId, documentId);
          await uploadFile(
            pdfStoragePath,
            display.bytes.buffer.slice(
              display.bytes.byteOffset,
              display.bytes.byteOffset + display.bytes.byteLength,
            ) as ArrayBuffer,
            display.contentType,
          );
          createdStoragePaths.push(pdfStoragePath);
        }
        const { error: documentError } = await db.from("documents").insert({
          id: documentId,
          workflow_id: workflow.id,
          user_id: userId,
          status: "processing",
          library_kind: "workflow_asset",
        });
        if (documentError) throw documentError;
        const { error: versionError } = await db
          .from("document_versions")
          .insert({
            id: versionId,
            document_id: documentId,
            storage_path: sourcePath,
            pdf_storage_path: pdfStoragePath,
            source: "upload",
            version_number: 1,
            filename: asset.filename,
            file_type: asset.file_type,
            size_bytes: asset.size_bytes ?? bytes.byteLength,
            content_sha256: contentHash,
          });
        if (versionError) throw versionError;
        const { error: readyError } = await db
          .from("documents")
          .update({
            current_version_id: versionId,
            status: "ready",
            updated_at: new Date().toISOString(),
          })
          .eq("id", documentId);
        if (readyError) throw readyError;
      }
    } catch {
      // Rollback order matters: drop the workflow row first, so nothing can
      // reference the half-made copies, then hand the object deletes to the
      // durable storage.cleanup job. A Promise.all of best-effort
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
        detail: "Failed to copy add-on assets",
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
      access_role: "owner",
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
