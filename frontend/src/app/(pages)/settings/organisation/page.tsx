"use client";

import { useEffect, useState, type ComponentProps } from "react";
import Link from "next/link";
import { useAuth } from "@/app/contexts/AuthContext";
import { useConfig } from "@/app/contexts/ConfigContext";
import {
    getTenantAdminStatus,
    getTenantAdminOverview,
    getTenantAdminContent,
    reassignTenantContent,
    INTERNAL_ERROR_MESSAGE,
    MikeApiError,
    type TenantAdminOverview,
    type TenantContentItem,
    type TenantContentKind,
} from "@/app/lib/mikeApi";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { Dropdown, DropdownTrigger, DropdownContent, DropdownRadioGroup, DropdownRadioItem } from "@/shared/ui/dropdown";

function OrganisationCard(props: ComponentProps<"div">) {
    return <GlassCardUI><div {...props} /></GlassCardUI>;
}

const PAGE_SIZE = 50;
const CONTENT_KINDS = [{ kind: "project", label: "Projects" }, { kind: "chat", label: "Chats" }, { kind: "review", label: "Reviews" }] as const;

function contentHref(item: TenantContentItem): string {
    const id = encodeURIComponent(item.id);
    if (item.kind === "project") return `/projects/${id}`;
    if (item.kind === "review") return `/tabular-reviews/${id}`;
    return item.projectId
        ? `/projects/${encodeURIComponent(item.projectId)}/assistant/chat/${id}`
        : `/assistant/chat/${id}`;
}

function failureMessage(error: unknown): string {
    return error instanceof MikeApiError ? error.message : INTERNAL_ERROR_MESSAGE;
}

function credits(value: string | null): string {
    return value === null ? "No limit" : `${value} credits`;
}

export default function OrganisationPage() {
    const config = useConfig();
    const { user, isAuthenticated, authLoading } = useAuth();
    const identity = user?.id ?? "";
    const [overview, setOverview] = useState<TenantAdminOverview | null>(null);
    const [loadedFor, setLoadedFor] = useState("");
    const [denied, setDenied] = useState(false);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const [kind, setKind] = useState<TenantContentKind>("project");
    const [offset, setOffset] = useState(0);
    const [content, setContent] = useState<TenantContentItem[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [contentLoading, setContentLoading] = useState(true);
    const [contentError, setContentError] = useState("");
    const [revision, setRevision] = useState(0);
    const [selected, setSelected] = useState<TenantContentItem | null>(null);
    const [newOwnerId, setNewOwnerId] = useState("");
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [notice, setNotice] = useState("");

    useEffect(() => {
        let cancelled = false;
        setOverview(null);
        setDenied(false);
        setError("");
        setLoadedFor("");
        setSelected(null);
        if (config.tenancyMode !== "pooled" || !isAuthenticated || authLoading) return;
        void (async () => {
            const status = await getTenantAdminStatus();
            if (cancelled) return;
            if (!status.isTenantAdmin) {
                setDenied(true);
                setLoadedFor(identity);
                return;
            }
            const next = await getTenantAdminOverview();
            if (!cancelled) {
                setOverview(next);
                setLoadedFor(identity);
            }
        })().catch((cause: unknown) => {
            if (!cancelled) { setError(failureMessage(cause)); setLoadedFor(identity); }
        });
        return () => { cancelled = true; };
    }, [config.tenancyMode, isAuthenticated, authLoading, identity, retry]);

    useEffect(() => {
        let cancelled = false;
        setContent([]);
        setHasMore(false);
        setContentError("");
        setContentLoading(true);
        if (!overview || loadedFor !== identity) return;
        void getTenantAdminContent(kind, offset, PAGE_SIZE).then((page) => {
            if (!cancelled) { setContent(page.items); setHasMore(page.hasMore); }
        }).catch((cause: unknown) => {
            if (!cancelled) setContentError(failureMessage(cause));
        }).finally(() => { if (!cancelled) setContentLoading(false); });
        return () => { cancelled = true; };
    }, [overview, loadedFor, identity, kind, offset, revision]);

    async function reassign() {
        if (!selected || !newOwnerId || !reason.trim()) return;
        setSaving(true);
        setSaveError("");
        try {
            await reassignTenantContent({ kind: selected.kind, id: selected.id, newOwnerId, reason: reason.trim() });
            setSelected(null);
            setNotice("Ownership reassigned.");
            setRevision((value) => value + 1);
        } catch (cause) {
            setSaveError(failureMessage(cause));
        } finally {
            setSaving(false);
        }
    }

    const heading = <h2 className="text-2xl font-medium font-serif text-gray-900">Organisation</h2>;
    if (config.tenancyMode !== "pooled" || (!authLoading && !isAuthenticated) || (loadedFor === identity && denied)) {
        return <div className="space-y-3">{heading}<p className="text-sm text-gray-500">Organisation administration is available to tenant admins.</p></div>;
    }
    if (loadedFor !== identity || (!overview && !error)) {
        return <div className="space-y-4" aria-busy="true">{heading}<OrganisationCard className="min-h-32 p-4"><p role="status" className="text-sm text-gray-500">Loading organisation…</p></OrganisationCard></div>;
    }
    if (!overview) {
        return <div className="space-y-4">{heading}<p role="alert" className="text-sm text-red-600">{error}</p><TextButtonUI onClick={() => setRetry((value) => value + 1)}>Try again</TextButtonUI></div>;
    }
    const memberName = (ownerId: string | null) => {
        const member = overview.members.find((entry) => entry.userId === ownerId);
        return member?.displayName || member?.email || ownerId || "Unassigned";
    };
    const selectedOwner = overview.members.find((member) => member.userId === newOwnerId);
    const controlPlaneUrl = overview.controlPlaneUrl || config.controlPlaneUrl;

    return (
        <div className="space-y-6 text-sm text-gray-700">
            <div className="space-y-3">
                {heading}
                <p className="text-gray-500">View content across your organisation. Access to other members’ content and ownership changes are recorded in the audit history.</p>
                {controlPlaneUrl ? <a href={controlPlaneUrl} target="_blank" rel="noopener noreferrer" className={textButtonUIClassName({ className: "inline-flex" })}>Manage members in the control plane</a> : <p className="text-xs text-gray-500">Member management is available through your control plane.</p>}
                <p className="text-xs text-gray-500">Enterprise memberships and roles are managed in Microsoft Entra.</p>
            </div>

            <section aria-labelledby="organisation-budget" className="space-y-3">
                <h3 id="organisation-budget" className="font-medium">Usage and budget</h3>
                <OrganisationCard className="p-4">
                    <p className="mb-3 text-xs text-gray-500">Period starting {overview.usage.periodStart.slice(0, 10)}</p>
                    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {[
                            ["Tokens used", overview.usage.totalTokens.toLocaleString()],
                            ["Usage credits", credits(overview.usage.totalCredits)],
                            ["Monthly budget", credits(overview.budget.monthlyCredits)],
                            ["Budget per member", credits(overview.budget.perUserCredits)],
                            ["Alert threshold", overview.budget.softThreshold === null ? "Not configured" : `${Number(overview.budget.softThreshold) * 100}%`],
                            ["Budget used", credits(overview.budget.usedCredits)],
                            ["Reserved", credits(overview.budget.reservedCredits)],
                        ].map(([label, value]) => <div key={label}><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd></div>)}
                    </dl>
                </OrganisationCard>
            </section>

            <section aria-labelledby="organisation-members" className="space-y-3">
                <h3 id="organisation-members" className="font-medium">Members</h3>
                <OrganisationCard className="divide-y divide-gray-200">
                    {overview.members.map((member) => {
                        const usage = overview.usage.byUser.find((entry) => entry.userId === member.userId);
                        return <div key={member.userId} className="flex flex-wrap items-start justify-between gap-3 p-4">
                            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]"><p className="font-medium">{member.displayName || member.email || member.userId}</p>{member.email && <p className="mt-1 text-xs text-gray-500">{member.email}</p>}<p className="mt-1 text-xs text-gray-500">{member.role === "TenantAdmin" ? "Tenant admin" : "Member"}</p></div>
                            <p className="text-xs text-gray-500">{(usage?.totalTokens ?? 0).toLocaleString()} tokens · {credits(usage?.totalCredits ?? "0")}</p>
                        </div>;
                    })}
                    {overview.members.length === 0 && <p className="p-4 text-gray-500">No members found.</p>}
                    {overview.usage.byUser.filter((entry) => !overview.members.some((member) => member.userId === entry.userId)).map((usage) => <div key={usage.userId ?? "background"} className="flex flex-wrap justify-between gap-3 p-4 text-xs text-gray-500"><span>{usage.userId ? `Former member (${usage.userId})` : "Background work"}</span><span>{usage.totalTokens.toLocaleString()} tokens · {credits(usage.totalCredits)}</span></div>)}
                </OrganisationCard>
            </section>

            <section aria-labelledby="organisation-content" className="space-y-3">
                <h3 id="organisation-content" className="font-medium">All content</h3>
                <div className="flex flex-wrap gap-2" aria-label="Content type">{CONTENT_KINDS.map((tab) => <TabPillButtonUI key={tab.kind} active={kind === tab.kind} onClick={() => { setKind(tab.kind); setOffset(0); setSelected(null); setNotice(""); }}>{tab.label}</TabPillButtonUI>)}</div>
                {notice && <p role="status" className="text-sm text-gray-500">{notice}</p>}
                <OrganisationCard className="min-h-32 divide-y divide-gray-200" aria-busy={contentLoading}>
                    {contentLoading ? <p role="status" className="p-4 text-gray-500">Loading content…</p> : contentError ? <div className="p-4"><p role="alert" className="text-red-600">{contentError}</p><TextButtonUI onClick={() => setRevision((value) => value + 1)}>Try again</TextButtonUI></div> : content.length === 0 ? <p className="p-4 text-gray-500">No content found.</p> : content.map((item) => <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]"><Link href={contentHref(item)} className="font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40">{item.title || "Untitled"}</Link><p className="mt-1 text-xs text-gray-500">Owner: {memberName(item.ownerId)}</p><p className="mt-1 text-xs text-gray-500">Created {item.createdAt.slice(0, 10)}</p></div>
                        <TextButtonUI disabled={saving} onClick={() => { setSelected(item); setNewOwnerId(""); setReason(""); setSaveError(""); setNotice(""); }}>Reassign{" "}<span className="sr-only">{item.title || "Untitled"}</span></TextButtonUI>
                    </div>)}
                </OrganisationCard>
                <div className="flex items-center justify-between gap-3"><TextButtonUI disabled={offset === 0 || contentLoading} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setSelected(null); }}>Previous</TextButtonUI><span className="text-xs text-gray-500">Page {Math.floor(offset / PAGE_SIZE) + 1}</span><TextButtonUI disabled={!hasMore || contentLoading} onClick={() => { setOffset(offset + PAGE_SIZE); setSelected(null); }}>Next</TextButtonUI></div>
            </section>

            {selected && <section aria-labelledby="reassign-title" className="space-y-3">
                <h3 id="reassign-title" className="font-medium [overflow-wrap:anywhere]">Reassign {selected.title || "Untitled"}</h3>
                <OrganisationCard className="space-y-4 p-4">
                    <p className="text-xs text-gray-500">For content owned by a team, the new owner must also be a member of that team. Shared system libraries cannot be reassigned.</p>
                    <div className="space-y-2"><FieldLabel as="p" id="new-owner-label">New owner</FieldLabel><Dropdown><DropdownTrigger asChild><PillButtonUI tone="white" className="h-auto min-h-7 max-w-full py-2 text-left leading-normal" aria-labelledby="new-owner-label new-owner-value" disabled={saving}><span id="new-owner-value" className="[overflow-wrap:anywhere]">{selectedOwner ? (selectedOwner.displayName && selectedOwner.email ? `${selectedOwner.displayName} (${selectedOwner.email})` : selectedOwner.displayName || selectedOwner.email || selectedOwner.userId) : "Choose a member"}</span></PillButtonUI></DropdownTrigger><DropdownContent className="max-w-[calc(100vw-2rem)]"><DropdownRadioGroup value={newOwnerId} onValueChange={setNewOwnerId}>{overview.members.filter((member) => member.userId !== selected.ownerId).map((member) => <DropdownRadioItem key={member.userId} value={member.userId}><span className="[overflow-wrap:anywhere]">{member.displayName || member.email || member.userId}{member.displayName && member.email ? ` (${member.email})` : ""}</span></DropdownRadioItem>)}</DropdownRadioGroup></DropdownContent></Dropdown></div>
                    <div className="space-y-2"><FieldLabel htmlFor="reassignment-reason">Reason for reassignment</FieldLabel><FormTextInput id="reassignment-reason" value={reason} maxLength={1000} disabled={saving} onChange={(event) => setReason(event.target.value)} /></div>
                    {saveError && <p role="alert" className="text-sm text-red-600">{saveError}</p>}
                    <div className="flex flex-wrap gap-3"><PillButtonUI tone="black" loading={saving} disabled={!newOwnerId || !reason.trim()} onClick={() => { void reassign(); }}>Confirm reassignment</PillButtonUI><TextButtonUI disabled={saving} onClick={() => setSelected(null)}>Cancel</TextButtonUI></div>
                </OrganisationCard>
            </section>}
        </div>
    );
}
