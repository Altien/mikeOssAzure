import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireUserFeature } from "../lib/userFeatures";
import { createServerDatabase } from "../lib/database";
import { checkProjectAccess } from "../lib/access";
import { createDocumentFromBytes } from "../lib/documentIngest";
import {
    IroncladError,
    downloadIroncladAttachment,
    findIroncladAttachment,
    getIroncladRecord,
    isIroncladConfigured,
    listIroncladRecords,
} from "../lib/ironclad";

export const ironcladRouter = Router();
ironcladRouter.use(requireAuth, requireUserFeature("ironclad"));

function requireConfigured(res: import("express").Response): boolean {
    if (isIroncladConfigured()) return true;
    res.status(503).json({
        detail: "Ironclad is not configured on this instance (set IRONCLAD_API_KEY).",
    });
    return false;
}

function handleIroncladError(
    res: import("express").Response,
    error: unknown,
    context: string,
): void {
    if (error instanceof IroncladError) {
        const status =
            error.status === 401 || error.status === 403
                ? 502
                : error.status >= 400 && error.status < 500
                  ? error.status
                  : 502;
        res.status(status).json({
            detail: error.message,
        });
        return;
    }
    console.error(`[ironclad] ${context} failed`, error);
    res.status(502).json({ detail: "Ironclad request failed." });
}

// GET /integrations/ironclad/status
ironcladRouter.get("/status", (_req, res) => {
    res.json({ configured: isIroncladConfigured() });
});

// GET /integrations/ironclad/records?search=&page=&pageSize=&sortField=&sortDirection=
ironcladRouter.get("/records", async (req, res) => {
    if (!requireConfigured(res)) return;
    const sortField = ["agreementDate", "name", "lastUpdated"].includes(
        String(req.query.sortField),
    )
        ? (String(req.query.sortField) as "agreementDate" | "name" | "lastUpdated")
        : undefined;
    const sortDirection = ["ASC", "DESC"].includes(String(req.query.sortDirection))
        ? (String(req.query.sortDirection) as "ASC" | "DESC")
        : undefined;
    try {
        const result = await listIroncladRecords({
            userEmail: res.locals.userEmail as string | undefined,
            search: typeof req.query.search === "string" ? req.query.search : undefined,
            page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
            pageSize:
                typeof req.query.pageSize === "string"
                    ? Number(req.query.pageSize)
                    : undefined,
            sortField,
            sortDirection,
        });
        res.json(result);
    } catch (error) {
        handleIroncladError(res, error, "list records");
    }
});

// GET /integrations/ironclad/records/:recordId
ironcladRouter.get("/records/:recordId", async (req, res) => {
    if (!requireConfigured(res)) return;
    try {
        const record = await getIroncladRecord({
            recordId: req.params.recordId,
            userEmail: res.locals.userEmail as string | undefined,
        });
        res.json(record);
    } catch (error) {
        handleIroncladError(res, error, "get record");
    }
});

// POST /integrations/ironclad/import
// Downloads the chosen attachment server-to-server and ingests it through the
// shared document pipeline (source: "ironclad").
ironcladRouter.post("/import", async (req, res) => {
    if (!requireConfigured(res)) return;
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { recordId, attachmentKey, projectId } = req.body as {
        recordId?: string;
        attachmentKey?: string;
        projectId?: string | null;
    };
    if (!recordId || !attachmentKey) {
        return void res
            .status(400)
            .json({ detail: "recordId and attachmentKey are required" });
    }

    const db = createServerDatabase();
    let targetProjectId: string | null = null;
    if (projectId) {
        const access = await checkProjectAccess(projectId, userId, userEmail, db);
        if (!access.ok) {
            return void res.status(404).json({ detail: "Project not found" });
        }
        targetProjectId = projectId;
    }

    let downloaded: Awaited<ReturnType<typeof downloadIroncladAttachment>>;
    try {
        const record = await getIroncladRecord({ recordId, userEmail });
        const attachment = findIroncladAttachment(record, attachmentKey);
        downloaded = await downloadIroncladAttachment({
            recordId,
            attachmentKey,
            userEmail,
            filenameHint: attachment?.filename ?? null,
            contentTypeHint: attachment?.contentType ?? null,
        });
    } catch (error) {
        return handleIroncladError(res, error, "download attachment");
    }

    const result = await createDocumentFromBytes({
        userId,
        projectId: targetProjectId,
        filename: downloaded.filename,
        content: downloaded.bytes,
        source: "ironclad",
        db,
    });
    if (!result.ok) {
        return void res.status(result.status).json({ detail: result.detail });
    }
    res.status(201).json({
        ...result.document,
        ironclad: { recordId, attachmentKey },
    });
});
