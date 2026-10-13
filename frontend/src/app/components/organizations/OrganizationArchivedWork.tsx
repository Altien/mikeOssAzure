"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import {
  deleteOrgDepartureArchive, isMfaRequiredError, listOrgDepartureArchives,
  listOrgMembers, recoverOrgDepartureArchive,
  type OrgDepartureArchive, type OrgMember,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const KIND_LABELS: Record<OrgDepartureArchive["kind"], string> = {
  project: "Project", workflow: "Workflow", chat: "Chat",
  tabular_review: "Tabular review", document: "Document",
};

/** Mounted only for organization owners; the API independently enforces it. */
export function OrganizationArchivedWork({ orgId }: { orgId: string }) {
  const [items, setItems] = useState<OrgDepartureArchive[] | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<OrgDepartureArchive | null>(null);
  const [deleting, setDeleting] = useState<OrgDepartureArchive | null>(null);
  const [mfaItem, setMfaItem] = useState<OrgDepartureArchive | null>(null);
  const [successor, setSuccessor] = useState("");
  const [working, setWorking] = useState(false);
  const loading = useRef(false);
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (offset = 0, refresh = false) => {
    if (loading.current && !refresh) return;
    if (refresh) generation.current += 1;
    loading.current = true;
    const current = generation.current;
    try {
      const page = await listOrgDepartureArchives(orgId, offset);
      if (current !== generation.current) return;
      setItems((previous) => offset === 0 ? page.items : [...(previous ?? []), ...page.items]);
      setNextOffset(page.nextOffset);
      setError(null);
    } catch (err) {
      if (current === generation.current) setError(userFacingApiError(err, "Could not load archived work."));
    } finally {
      if (current === generation.current) loading.current = false;
    }
  }, [orgId]);

  const loadMembers = useCallback(async () => {
    const current = generation.current;
    try {
      const roster = await listOrgMembers(orgId);
      if (current === generation.current) { setMembers(roster); setMemberError(null); }
    } catch (err) {
      if (current === generation.current) setMemberError(userFacingApiError(err, "Could not load organization members."));
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    void loadMembers();
    return () => { generation.current += 1; loading.current = false; };
  }, [load, loadMembers]);

  useEffect(() => {
    if (nextOffset === null || error || !sentinel.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void load(nextOffset);
    }, { rootMargin: "200px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [nextOffset, error, load]);

  async function recover() {
    if (!recovering || !successor) return;
    setWorking(true);
    try {
      await recoverOrgDepartureArchive(orgId, recovering.id, successor);
      setRecovering(null);
      await load(0, true);
    } catch (err) {
      setError(userFacingApiError(err, "Could not recover this work."));
    } finally { setWorking(false); }
  }

  async function remove(item: OrgDepartureArchive) {
    setWorking(true);
    try {
      await deleteOrgDepartureArchive(orgId, item.id);
      setDeleting(null);
      await load(0, true);
    } catch (err) {
      if (isMfaRequiredError(err)) { setDeleting(null); setMfaItem(item); }
      else setError(userFacingApiError(err, "Could not delete this work."));
    } finally { setWorking(false); }
  }

  return (
    <section className="space-y-3" aria-labelledby="org-archived-work">
      <SettingsHeading id="org-archived-work">Archived work</SettingsHeading>
      <p className="text-sm text-gray-500">
        Private, unshared work left by departed members is kept for 30 days.
        Only organization owners can recover, reassign or delete it.
        Work not recovered by its deletion date is permanently deleted.
      </p>
      {error && !recovering ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      {memberError ? <p role="alert" className="text-sm text-red-600">{memberError}</p> : null}
      {(error || memberError) && !recovering && !deleting ? (
        <PillButtonUI tone="white" size="sm" onClick={() => { void load(nextOffset ?? 0); void loadMembers(); }}>Try again</PillButtonUI>
      ) : null}
      <GlassCardUI>
        {items === null && !error ? [1, 2].map((id) => (
          <SettingsRow key={id}>
            <div className="min-w-0 flex-1 space-y-2"><SkeletonLine className="w-40" /><SkeletonLine className="w-56 max-w-full" /></div>
            <SkeletonLine className="h-7 w-36" />
          </SettingsRow>
        )) : items?.length === 0 ? (
          <SettingsRow><p className="text-sm text-gray-500">No archived work.</p></SettingsRow>
        ) : items?.map((item) => (
          <SettingsRow key={item.id}>
            <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
              <p className="text-sm font-medium text-gray-700">{item.title}</p>
              <p className="text-xs text-gray-500">{KIND_LABELS[item.kind]} · Deletes {new Date(item.expires_at).toLocaleDateString()}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <PillButtonUI tone="white" size="sm" disabled={working} aria-label={`Delete ${item.title}`} onClick={() => { setError(null); setDeleting(item); }}>Delete</PillButtonUI>
              <PillButtonUI tone="blue" size="sm" disabled={working || !members.length} aria-label={`Recover ${item.title}`} onClick={() => {
                setError(null); setSuccessor(members.find((member) => member.role === "owner")?.user_id ?? ""); setRecovering(item);
              }}>Recover</PillButtonUI>
            </div>
          </SettingsRow>
        ))}
      </GlassCardUI>
      {nextOffset !== null ? <div ref={sentinel} role="status" aria-label="Loading more archived work"><SkeletonLine className="w-32" /></div> : null}
      <Modal open={recovering !== null} onClose={() => { if (!working) setRecovering(null); }}
        breadcrumbs={["Organization", "Archived work", "Recover"]} size="sm"
        cancelAction={{ label: "Cancel", disabled: working, onClick: () => setRecovering(null) }}
        primaryAction={{ label: working ? "Recovering..." : "Recover", disabled: working || !successor, onClick: () => void recover() }}>
        <div className="space-y-4 pb-4">
          <p className="text-sm text-gray-700 [overflow-wrap:anywhere]">Recover {recovering?.title} and assign an owner. Its contents will be retained with it.</p>
          <ModalSelect id="archive-successor" aria-label="Assign recovered work to" value={successor} onChange={setSuccessor} wrapLabels disabled={working}
            options={members.map((member) => ({ value: member.user_id, label: member.display_name || member.email || "Unnamed member", suffix: member.display_name && member.email ? `(${member.email})` : undefined }))} />
          {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        </div>
      </Modal>
      <ConfirmPopup open={deleting !== null} title="Delete archived work?"
        message={`Permanently delete ${deleting?.title ?? "this item"} and its contents? This cannot be undone.`}
        confirmLabel="Delete" confirmVariant="danger" confirmStatus={working ? "loading" : "idle"}
        onCancel={() => { if (!working) setDeleting(null); }} onConfirm={() => { if (deleting) void remove(deleting); }} />
      <MfaVerificationPopup open={mfaItem !== null} onCancel={() => setMfaItem(null)} onVerified={() => {
        const item = mfaItem; setMfaItem(null); if (item) void remove(item);
      }} />
    </section>
  );
}
