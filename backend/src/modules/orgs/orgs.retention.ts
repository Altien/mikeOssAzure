import type { OrgDepartureArchive, OrgDepartureArchivePage } from "@mike/contracts";
import { getOrgRole } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "../documents/documents.service";

interface ArchiveActor { orgId: string; userId: string }

async function requireOwner(db: Db, actor: ArchiveActor) {
    const role = await getOrgRole(actor.userId, actor.orgId, db);
    if (!role) return failure("not_found", "Organization not found.");
    if (role !== "owner") return failure("forbidden", "Only organization owners can manage archived work.");
    return null;
}

export async function listDepartureArchives(
    db: Db,
    actor: ArchiveActor & { limit: number; offset: number },
): Promise<ServiceResult<OrgDepartureArchivePage>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    const { data, error } = await db.rpc("list_org_departure_archives", {
        p_org_id: actor.orgId, p_actor_id: actor.userId,
        p_limit: actor.limit + 1, p_offset: actor.offset,
    });
    if (error) return internalFailure(error);
    const rows = (data ?? []) as OrgDepartureArchive[];
    return ok({ items: rows.slice(0, actor.limit), nextOffset: rows.length > actor.limit ? actor.offset + actor.limit : null });
}

async function cleanupKeys(db: Db, item: Pick<OrgDepartureArchive, "kind" | "item_id">) {
    if (item.kind === "project") return captureInlineDocumentCleanup(db, { projectIds: [item.item_id] });
    if (item.kind === "workflow") return captureInlineDocumentCleanup(db, { workflowId: item.item_id });
    if (item.kind === "document") return captureInlineDocumentCleanup(db, { documentIds: [item.item_id] });
    return [];
}

export async function resolveDepartureArchive(
    db: Db,
    actor: ArchiveActor & { archiveId: string; successorId?: unknown; delete: boolean },
): Promise<ServiceResult<null>> {
    const denied = await requireOwner(db, actor);
    if (denied) return denied;
    if (!actor.delete && (typeof actor.successorId !== "string" || !actor.successorId)) {
        return failure("validation", "Choose a member to own the recovered work.");
    }
    const { data: item, error: readError } = await db.from("org_departure_archives")
        .select("kind, item_id").eq("org_id", actor.orgId).eq("id", actor.archiveId).maybeSingle();
    if (readError) return internalFailure(readError);
    if (!item) return failure("not_found", "Archived item not found.");
    const keys = actor.delete ? await cleanupKeys(db, item as OrgDepartureArchive) : [];
    const { error } = await db.rpc("resolve_org_departure_archive", {
        p_org_id: actor.orgId, p_archive_id: actor.archiveId, p_actor_id: actor.userId,
        p_successor_id: actor.delete ? null : actor.successorId, p_delete: actor.delete,
    });
    if (error?.code === "42501") return failure("forbidden", "Only organization owners can manage archived work.");
    if (error?.code === "P0002") return failure("not_found", "Archived item not found.");
    if (error?.code === "23514") return failure("conflict", "The recovery period has ended or the selected member is no longer available. Refresh and try again.");
    if (error?.code === "22P02") return failure("validation", "Choose a current organization member.");
    if (error) return internalFailure(error);
    if (actor.delete) await completeInlineDocumentCleanup(db, keys);
    return ok(null);
}

/** Bounded, retryable sweep; the database serializes recovery against expiry. */
export async function expireDepartureArchives(db: Db): Promise<number> {
    const { data: expired, error: readError } = await db.from("org_departure_archives")
        .select("kind, item_id").lte("expires_at", new Date().toISOString())
        .order("expires_at").order("id").limit(100);
    if (readError) throw new Error("Could not load expired organization archives");
    const keys: string[] = [];
    for (const item of (expired ?? []) as OrgDepartureArchive[]) keys.push(...await cleanupKeys(db, item));
    const { data, error } = await db.rpc("expire_org_departure_archives", { p_limit: 100 });
    if (error) throw new Error("Could not expire organization archives");
    await completeInlineDocumentCleanup(db, keys);
    return Number(data ?? 0);
}
