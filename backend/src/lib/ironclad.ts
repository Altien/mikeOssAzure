/**
 * Ironclad CLM API client (instance-level credentials).
 *
 * Config via environment:
 *   IRONCLAD_API_KEY       - bearer token (OAuth client-credentials or legacy)
 *   IRONCLAD_BASE_URL      - regional base URL (default https://na1.ironcladapp.com)
 *   IRONCLAD_AS_USER_EMAIL - actor for client-credentials tokens; falls back
 *                            to the signed-in Mike user's email per request.
 *
 * Docs: https://developer.ironcladapp.com/reference/list-all-records
 */

import { ALLOWED_DOCUMENT_TYPES } from "./documentTypes";

const DEFAULT_BASE_URL = "https://na1.ironcladapp.com";
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const OCTET_STREAM = "application/octet-stream";
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        "pptx",
};

export class IroncladError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "IroncladError";
        this.status = status;
    }
}

export function isIroncladConfigured(): boolean {
    return !!process.env.IRONCLAD_API_KEY?.trim();
}

function baseUrl(): string {
    return (process.env.IRONCLAD_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
        /\/+$/,
        "",
    );
}

function headers(userEmail?: string | null): Record<string, string> {
    const result: Record<string, string> = {
        Authorization: `Bearer ${process.env.IRONCLAD_API_KEY!.trim()}`,
        Accept: "application/json",
    };
    const actor =
        process.env.IRONCLAD_AS_USER_EMAIL?.trim() || userEmail?.trim() || "";
    if (actor) result["x-as-user-email"] = actor.toLowerCase();
    return result;
}

async function ironcladFetch(
    path: string,
    userEmail: string | null | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
    const response = await fetch(`${baseUrl()}${path}`, {
        headers: headers(userEmail),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
        throw new IroncladError(
            "Ironclad rejected the request (check IRONCLAD_API_KEY and actor email permissions).",
            response.status,
        );
    }
    if (response.status === 404) {
        throw new IroncladError("Ironclad record or attachment not found.", 404);
    }
    throw new IroncladError(
        `Ironclad request failed (${response.status}): ${body.slice(0, 300)}`,
        response.status,
    );
}

export type IroncladRecordSummary = {
    id: string;
    name: string;
    type: string | null;
    agreementDate: string | null;
    lastUpdated: string | null;
    counterpartyName: string | null;
};

export type IroncladRecordListResult = {
    list: IroncladRecordSummary[];
    page: number;
    pageSize: number;
    totalCount: number | null;
};

function propertyValue(record: Record<string, unknown>, key: string): unknown {
    const properties = record.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        return undefined;
    }
    const entry = (properties as Record<string, unknown>)[key];
    if (entry && typeof entry === "object" && !Array.isArray(entry) && "value" in entry) {
        return (entry as { value: unknown }).value;
    }
    return entry;
}

function entityName(value: unknown): string | null {
    if (typeof value === "string") return value || null;
    if (Array.isArray(value)) {
        const names = value
            .map((item) => entityName(item))
            .filter((name): name is string => !!name);
        return names.length ? names.join(", ") : null;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const name = record.name ?? record.displayName;
        if (typeof name === "string" && name) return name;
    }
    return null;
}

function stringValue(value: unknown): string | null {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
}

function summarizeRecord(raw: unknown): IroncladRecordSummary | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const id = record.id ?? record.ironcladId;
    if (typeof id !== "string" || !id) return null;
    return {
        id,
        name:
            (typeof record.name === "string" && record.name) ||
            (typeof record.title === "string" && record.title) ||
            id,
        type: stringValue(record.type) ?? stringValue(propertyValue(record, "type")),
        agreementDate:
            stringValue(record.agreementDate) ??
            stringValue(propertyValue(record, "agreementDate")),
        lastUpdated:
            stringValue(record.lastUpdated) ??
            stringValue(propertyValue(record, "lastUpdated")),
        counterpartyName:
            entityName(propertyValue(record, "counterpartyName")) ??
            entityName(record.counterparty),
    };
}

export async function listIroncladRecords(params: {
    userEmail?: string | null;
    search?: string;
    page?: number;
    pageSize?: number;
    sortField?: "agreementDate" | "name" | "lastUpdated";
    sortDirection?: "ASC" | "DESC";
}): Promise<IroncladRecordListResult> {
    const page = Math.max(0, Math.floor(params.page ?? 0));
    const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));
    const sortField = params.sortField ?? "lastUpdated";
    const sortDirection = params.sortDirection ?? "DESC";
    const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortField,
        sortDirection,
    });
    if (params.search?.trim()) query.set("search", params.search.trim());

    const response = await ironcladFetch(
        `/public/api/v1/records?${query.toString()}`,
        params.userEmail,
    );
    const json = (await response.json()) as Record<string, unknown>;
    const rawList = Array.isArray(json.list) ? json.list : [];
    return {
        list: rawList
            .map(summarizeRecord)
            .filter((item): item is IroncladRecordSummary => !!item),
        page,
        pageSize,
        totalCount:
            typeof json.totalCount === "number"
                ? json.totalCount
                : typeof json.total === "number"
                  ? json.total
                  : null,
    };
}

export type IroncladAttachment = {
    key: string;
    filename: string | null;
    contentType: string | null;
};

export type IroncladRecordDetail = IroncladRecordSummary & {
    attachments: IroncladAttachment[];
};

export function findIroncladAttachment(
    record: IroncladRecordDetail,
    key: string,
): IroncladAttachment | null {
    return (
        record.attachments.find((attachment) => attachment.key === key) ?? null
    );
}

function attachmentFilename(key: string, value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const field of ["filename", "fileName", "name", "displayName"]) {
        if (typeof record[field] === "string" && record[field]) {
            return record[field] as string;
        }
    }
    return key === "signedCopy" ? "Signed copy" : null;
}

export async function getIroncladRecord(params: {
    recordId: string;
    userEmail?: string | null;
}): Promise<IroncladRecordDetail> {
    const response = await ironcladFetch(
        `/public/api/v1/records/${encodeURIComponent(params.recordId)}`,
        params.userEmail,
    );
    const json = (await response.json()) as Record<string, unknown>;
    const summary = summarizeRecord(json);
    if (!summary) throw new IroncladError("Ironclad record not found.", 404);

    const attachments: IroncladAttachment[] = [];
    const rawAttachments = json.attachments;
    if (rawAttachments && typeof rawAttachments === "object" && !Array.isArray(rawAttachments)) {
        for (const [key, value] of Object.entries(
            rawAttachments as Record<string, unknown>,
        )) {
            attachments.push({
                key,
                filename: attachmentFilename(key, value),
                contentType:
                    value && typeof value === "object"
                        ? ((value as Record<string, unknown>).contentType as string | null) ??
                          ((value as Record<string, unknown>).mimeType as string | null) ??
                          null
                        : null,
            });
        }
    } else if (Array.isArray(rawAttachments)) {
        for (const item of rawAttachments) {
            if (!item || typeof item !== "object") continue;
            const record = item as Record<string, unknown>;
            const key =
                (typeof record.key === "string" && record.key) ||
                (typeof record.id === "string" && record.id) ||
                "";
            if (!key) continue;
            attachments.push({
                key,
                filename: attachmentFilename(key, record),
                contentType:
                    (record.contentType as string | null) ??
                    (record.mimeType as string | null) ??
                    null,
            });
        }
    }
    // Records created from signed workflows always expose a signedCopy; keep
    // it listed even when the record payload omits attachment metadata.
    if (!attachments.some((attachment) => attachment.key === "signedCopy")) {
        attachments.unshift({
            key: "signedCopy",
            filename: "Signed copy",
            contentType: "application/pdf",
        });
    }

    return { ...summary, attachments };
}

function filenameFromContentDisposition(value: string | null): string | null {
    if (!value) return null;
    const star = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim().replace(/"/g, ""));
        } catch {
            return star[1].trim().replace(/"/g, "");
        }
    }
    const plain = value.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
}

function normalizedContentType(value: string | null | undefined): string | null {
    const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? "";
    return normalized || null;
}

function extensionFromFilename(filename: string): string | null {
    const match = filename.trim().match(/\.([a-z0-9]{1,8})$/i);
    const extension = match?.[1]?.toLowerCase() ?? null;
    return extension && ALLOWED_DOCUMENT_TYPES.has(extension) ? extension : null;
}

function extensionFromContentType(contentType: string | null): string | null {
    if (!contentType) return null;
    const extension = CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()] ?? null;
    return extension && ALLOWED_DOCUMENT_TYPES.has(extension) ? extension : null;
}

function cleanFilename(filename: string): string {
    return filename
        .trim()
        .replace(/[\x00-\x1F\x7F]/g, "_")
        .replace(/[\\/]/g, "_")
        .slice(0, 200);
}

function filenameStem(filename: string): string {
    const cleaned = cleanFilename(filename);
    return cleaned.replace(/\.[a-z0-9]{1,8}$/i, "").trim() || "ironclad-attachment";
}

function resolveDownloadFilename(params: {
    attachmentKey: string;
    contentDisposition: string | null;
    responseContentType: string | null;
    filenameHint?: string | null;
    contentTypeHint?: string | null;
}): string {
    const headerFilename = filenameFromContentDisposition(
        params.contentDisposition,
    );
    for (const candidate of [headerFilename, params.filenameHint]) {
        if (!candidate) continue;
        const extension = extensionFromFilename(candidate);
        if (extension) return cleanFilename(candidate);
    }

    const contentType =
        params.responseContentType && params.responseContentType !== OCTET_STREAM
            ? params.responseContentType
            : normalizedContentType(params.contentTypeHint);
    const extension = extensionFromContentType(contentType);
    if (extension) {
        const stem = filenameStem(
            headerFilename || params.filenameHint || params.attachmentKey,
        );
        return `${stem}.${extension}`;
    }

    throw new IroncladError(
        "Ironclad attachment did not include a supported filename or content type.",
        422,
    );
}

export async function downloadIroncladAttachment(params: {
    recordId: string;
    attachmentKey: string;
    userEmail?: string | null;
    filenameHint?: string | null;
    contentTypeHint?: string | null;
}): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
    const response = await ironcladFetch(
        `/public/api/v1/records/${encodeURIComponent(params.recordId)}/attachments/${encodeURIComponent(params.attachmentKey)}`,
        params.userEmail,
        DOWNLOAD_TIMEOUT_MS,
    );
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new IroncladError(
            `Attachment exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB import limit.`,
            413,
        );
    }
    const contentType =
        normalizedContentType(response.headers.get("content-type")) ||
        normalizedContentType(params.contentTypeHint) ||
        OCTET_STREAM;
    const filename = resolveDownloadFilename({
        attachmentKey: params.attachmentKey,
        contentDisposition: response.headers.get("content-disposition"),
        responseContentType: contentType,
        filenameHint: params.filenameHint,
        contentTypeHint: params.contentTypeHint,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new IroncladError(
            `Attachment exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB import limit.`,
            413,
        );
    }
    return { bytes, filename, contentType };
}
