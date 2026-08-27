import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDatabase } from "../lib/database";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { verifyDownload } from "../lib/downloadTokens";
import { signDownload } from "../lib/downloadTokens";
import { ensureDocAccess } from "../lib/access";
import { contentTypeForDocumentType } from "../lib/documentTypes";

export const downloadsRouter = Router();

function contentTypeFor(filename: string): string {
    const suffix = filename.includes(".")
        ? filename.split(".").pop()?.toLowerCase()
        : "";
    return contentTypeForDocumentType(suffix);
}

async function resolveDownloadVersion(path: string) {
    const db = createServerDatabase();
    const { data } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", path)
        .is("deleted_at", null)
        .maybeSingle();
    return data as { id: string; document_id: string } | null;
}

// The Word desktop URI handler cannot attach MikeOSS's bearer token. Exchange
// an authenticated, access-checked download URL for a five-minute capability
// URL that Word can fetch directly.
downloadsRouter.post("/office-link/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info) return void res.status(404).json({ detail: "Invalid link" });

    const version = await resolveDownloadVersion(info.path);
    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const db = createServerDatabase();
    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .eq("id", version.document_id)
        .single();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    const shortToken = signDownload(info.path, info.filename, 5 * 60);
    res.json({ download_url: `/download/office/${shortToken}` });
});

// Public only by possession of the short-lived HMAC token minted above.
downloadsRouter.get("/office/:token", async (req, res) => {
    const info = verifyDownload(req.params.token);
    const latestAllowedExpiry = Math.floor(Date.now() / 1000) + 5 * 60;
    if (!info || !info.expiresAt || info.expiresAt > latestAllowedExpiry) {
        return void res.status(404).json({ detail: "Invalid link" });
    }
    const version = await resolveDownloadVersion(info.path);
    if (!version)
        return void res.status(404).json({ detail: "File not found" });
    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.send(Buffer.from(raw));
});

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid link" });

    const db = createServerDatabase();
    const version = await resolveDownloadVersion(info.path);

    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .eq("id", version.document_id)
        .single();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.send(Buffer.from(raw));
});
