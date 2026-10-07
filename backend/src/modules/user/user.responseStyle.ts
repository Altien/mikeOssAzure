// user response style — implementation behind the module facade.
//
// How the user wants assistant answers written, from Settings >
// Personalisation. Like custom instructions it has its own endpoint, so the
// profile select cascade (user.profile.storage.ts) does not have to carry it.
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { RESPONSE_LANGUAGE_CODES } from "../../lib/responseLanguages";
import { type Db } from "./user.shared";

/**
 * The first three lists mirror their user_profiles_response_*_check
 * constraints. Languages are owned here (lib/responseLanguages); the database
 * only checks the tag's shape.
 */
export const RESPONSE_STYLE_OPTIONS = {
    verbosity: ["concise", "balanced", "detailed"],
    // The "Headers and Lists" setting: how much structure answers use.
    formatting: ["balanced", "less", "more"],
    tone: ["formal", "balanced", "plain"],
    language: RESPONSE_LANGUAGE_CODES,
} as const;

type Options = typeof RESPONSE_STYLE_OPTIONS;
export type ResponseStyleField = keyof Options;
export type ResponseStyle = {
    [Field in ResponseStyleField]: Options[Field][number];
};

export const DEFAULT_RESPONSE_STYLE: ResponseStyle = {
    verbosity: "balanced",
    formatting: "balanced",
    tone: "balanced",
    language: "auto",
};

const COLUMNS: Record<ResponseStyleField, string> = {
    verbosity: "response_verbosity",
    formatting: "response_formatting",
    tone: "response_tone",
    language: "response_language",
};

const FIELDS = Object.keys(COLUMNS) as ResponseStyleField[];
const SELECT = FIELDS.map((field) => COLUMNS[field]).join(", ");

function isOption<Field extends ResponseStyleField>(
    field: Field,
    value: unknown,
): value is ResponseStyle[Field] {
    return (
        typeof value === "string" &&
        (RESPONSE_STYLE_OPTIONS[field] as readonly string[]).includes(value)
    );
}

function isMissingColumn(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const message = typeof record.message === "string" ? record.message : "";
    return (
        record.code === "42703" &&
        FIELDS.some((field) => message.includes(COLUMNS[field]))
    );
}

/** Unknown or missing values fall back field by field to the default. */
function toResponseStyle(row: unknown): ResponseStyle {
    const record = (row ?? {}) as Record<string, unknown>;
    const style = { ...DEFAULT_RESPONSE_STYLE };
    for (const field of FIELDS) {
        const value = record[COLUMNS[field]];
        if (isOption(field, value)) {
            (style as Record<ResponseStyleField, string>)[field] = value;
        }
    }
    return style;
}

/**
 * Reads the stored style. A database that has not applied the migration yet
 * reads as the default instead of failing every chat request.
 */
export async function loadResponseStyle(
    db: Db,
    userId: string,
): Promise<ResponseStyle> {
    const { data, error } = await db
        .from("user_profiles")
        .select(SELECT)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isMissingColumn(error)) return DEFAULT_RESPONSE_STYLE;
        throw error;
    }
    return toResponseStyle(data);
}

export async function getResponseStyle(
    db: Db,
    userId: string,
): Promise<ServiceResult<ResponseStyle>> {
    try {
        return ok(await loadResponseStyle(db, userId));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Accepts any non-empty subset of the fields, so each setting saves on its
 * own and two quick changes to different settings cannot undo each other.
 */
export function validateResponseStylePayload(
    body: unknown,
):
    | { ok: true; update: Partial<ResponseStyle> }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const raw = body as Record<string, unknown>;
    const keys = Object.keys(raw);
    const invalidField = keys.find(
        (key) => !(FIELDS as string[]).includes(key),
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported response style field: ${invalidField}`,
        };
    }
    if (keys.length === 0) {
        return { ok: false, detail: "Expected at least one response style field" };
    }
    const update: Partial<ResponseStyle> = {};
    for (const field of keys as ResponseStyleField[]) {
        const value = raw[field];
        if (!isOption(field, value)) {
            return {
                ok: false,
                detail: `${field} must be one of: ${RESPONSE_STYLE_OPTIONS[field].join(", ")}`,
            };
        }
        (update as Record<ResponseStyleField, string>)[field] = value;
    }
    return { ok: true, update };
}

export async function saveResponseStyle(
    db: Db,
    userId: string,
    update: Partial<ResponseStyle>,
): Promise<ServiceResult<ResponseStyle>> {
    const row: Record<string, string> = {
        updated_at: new Date().toISOString(),
    };
    for (const field of FIELDS) {
        const value = update[field];
        if (value !== undefined) row[COLUMNS[field]] = value;
    }
    const { data, error } = await db
        .from("user_profiles")
        .update(row)
        .eq("user_id", userId)
        .select(SELECT)
        .maybeSingle();
    if (error) {
        if (isMissingColumn(error)) {
            return failure(
                "unavailable",
                "Response style settings are not available yet.",
            );
        }
        return internalFailure(error);
    }
    if (!data) return failure("not_found", "Profile not found");
    return ok(toResponseStyle(data));
}
