"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
  getOrgMemberHandover,
  listOrgMembers,
  removeOrgMember,
  type OrgMember,
  type OrgMemberHandover,
} from "@/app/lib/mikeApi";

// The step between asking for somebody to be removed from an organization
// (or asking to leave it) and it happening.
//
// A member's work does not simply vanish or drift to whoever is in charge:
//
//   * the private projects and workflows they alone own are handed to a
//     member chosen here, by the admin removing them or by the member
//     themselves when leaving;
//   * their own standalone chats and tabular reviews are private to them and
//     are deleted.
//
// So this dialog first asks the server what the departure would do, says so,
// and — when there is something to hand over — will not go on until a
// successor is named.

export interface DepartingMember {
  user_id: string;
  display_name?: string | null;
  email?: string | null;
}

export interface MemberDepartureResult {
  /** The members who are gone. */
  removedUserIds: string[];
  /** Why the first of the others is not, if any could not be removed. */
  error: unknown | null;
}

/** How many titles are listed before the rest are counted. */
const LISTED_ITEMS = 6;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function joinCounts(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : parts.join(" and ");
}

const nameOf = (member: DepartingMember) =>
  member.display_name?.trim() || member.email || "This member";

export function MemberDepartureDialog({
  orgId,
  departing,
  leaving = false,
  members,
  onCancel,
  onDone,
}: {
  orgId: string;
  /** Who is going: one person, or several removed together. */
  departing: DepartingMember[];
  /** The one person going is the signed-in user. */
  leaving?: boolean;
  /** The organization's members, when the caller already has them. */
  members?: OrgMember[];
  onCancel: () => void;
  onDone: (result: MemberDepartureResult) => void;
}) {
  const [handovers, setHandovers] = useState<OrgMemberHandover[] | null>(null);
  const [loadedMembers, setLoadedMembers] = useState<OrgMember[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [successor, setSuccessor] = useState("");
  const [working, setWorking] = useState(false);

  const departingIds = departing.map((member) => member.user_id).join(",");
  const hasRoster = members !== undefined;
  useEffect(() => {
    let cancelled = false;
    const ids = departingIds.split(",").filter(Boolean);
    Promise.all([
      Promise.all(ids.map((id) => getOrgMemberHandover(orgId, id))),
      hasRoster ? Promise.resolve(null) : listOrgMembers(orgId),
    ]).then(
      ([loaded, roster]) => {
        if (cancelled) return;
        setHandovers(loaded);
        setLoadedMembers(roster);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orgId, departingIds, hasRoster]);

  const roster = members ?? loadedMembers;
  const candidates = useMemo(
    () =>
      (roster ?? [])
        .filter(
          (member) =>
            !departing.some((gone) => gone.user_id === member.user_id),
        )
        .map((member) => {
          const name = member.display_name?.trim();
          return {
            value: member.user_id,
            label: name || member.email || "Unnamed member",
            // Shown in full beneath the control once chosen: the control
            // itself is one line, and two members can share a name.
            email: name ? member.email : null,
          };
        }),
    [roster, departing],
  );

  const chosen = candidates.find((candidate) => candidate.value === successor);

  const projects = (handovers ?? []).flatMap((handover) => handover.projects);
  const workflows = (handovers ?? []).flatMap((handover) => handover.workflows);
  const chats = (handovers ?? []).reduce((sum, h) => sum + h.chats, 0);
  const reviews = (handovers ?? []).reduce((sum, h) => sum + h.reviews, 0);
  const owed = projects.length + workflows.length;
  const titles = [...projects, ...workflows].map(
    (item) => item.title.trim() || "Untitled",
  );

  const several = departing.length > 1;
  const who = leaving
    ? "You"
    : several
      ? "These members"
      : nameOf(departing[0] ?? { user_id: "" });
  const lead = leaving
    ? "You will lose access to this organization's shared resources."
    : several
      ? `${departing.length} selected members will lose access to this organization.`
      : `${who} will lose organization access.`;
  const owedSummary = joinCounts([
    ...(projects.length ? [count(projects.length, "project")] : []),
    ...(workflows.length ? [count(workflows.length, "workflow")] : []),
  ]);
  const deletedSummary = joinCounts([
    ...(chats ? [count(chats, "private chat")] : []),
    ...(reviews ? [count(reviews, "tabular review")] : []),
  ]);

  const ready = handovers !== null && roster !== null && !loadFailed;
  const canConfirm = ready && !working && (owed === 0 || successor !== "");

  async function confirm() {
    if (!canConfirm) return;
    setWorking(true);
    const results = await Promise.allSettled(
      departing.map((member) =>
        removeOrgMember(orgId, member.user_id, successor || undefined),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    onDone({
      removedUserIds: departing
        .filter((_, index) => results[index]?.status === "fulfilled")
        .map((member) => member.user_id),
      error: failure ? failure.reason : null,
    });
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!working) onCancel();
      }}
      breadcrumbs={[
        leaving
          ? "Leave organization"
          : several
            ? "Remove members"
            : "Remove member",
      ]}
      size="sm"
      className="h-auto max-h-[calc(100vh-2rem)]"
      cancelAction={{
        label: "Cancel",
        disabled: working,
        onClick: onCancel,
      }}
      primaryAction={{
        label: working
          ? leaving
            ? "Leaving..."
            : "Removing..."
          : leaving
            ? "Leave"
            : "Remove",
        variant: "danger",
        disabled: !canConfirm,
        onClick: () => void confirm(),
      }}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 min-w-0 space-y-5 overflow-y-auto pb-4"
      >
        <p className="text-sm text-gray-700">{lead}</p>

        {loadFailed ? (
          <p role="alert" className="text-sm text-red-600">
            Could not check what would be handed over. Close this and try
            again.
          </p>
        ) : !ready ? (
          <div
            role="status"
            aria-label="Checking what would be handed over"
            className="space-y-2"
          >
            <span className="block h-3 w-3/4 animate-pulse rounded bg-gray-200" />
            <span className="block h-9 w-full animate-pulse rounded-xl bg-gray-100" />
          </div>
        ) : (
          <>
            {owed > 0 ? (
              <section className="space-y-2">
                <FieldLabel htmlFor="member-departure-successor">
                  Hand over to
                </FieldLabel>
                <p className="text-sm text-gray-600">
                  {who} {leaving || several ? "are" : "is"} the only{" "}
                  {several ? "owners" : "owner"} of {owedSummary}. Choose who
                  takes {owed === 1 ? "it" : "them"} over.
                </p>
                <ul className="space-y-1 text-sm text-gray-700">
                  {titles.slice(0, LISTED_ITEMS).map((title, index) => (
                    <li
                      key={`${index}-${title}`}
                      className="break-words [overflow-wrap:anywhere]"
                    >
                      {title}
                    </li>
                  ))}
                  {titles.length > LISTED_ITEMS ? (
                    <li className="text-gray-500">
                      and {titles.length - LISTED_ITEMS} more
                    </li>
                  ) : null}
                </ul>
                {candidates.length > 0 ? (
                  <>
                    <ModalSelect
                      id="member-departure-successor"
                      value={successor}
                      onChange={setSuccessor}
                      options={candidates}
                      placeholder="Choose a member"
                      disabled={working}
                    />
                    {chosen?.email ? (
                      <p className="break-words text-xs text-gray-500 [overflow-wrap:anywhere]">
                        {chosen.email}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p role="alert" className="text-sm text-red-600">
                    There is no other member to hand this to.
                  </p>
                )}
              </section>
            ) : null}

            {deletedSummary ? (
              <p className="text-sm text-gray-600">
                {leaving ? "Your" : several ? "Their" : `${who}'s`}{" "}
                {deletedSummary} in this organization will be permanently
                deleted.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
