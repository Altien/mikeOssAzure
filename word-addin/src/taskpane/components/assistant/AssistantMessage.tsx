import React from "react";
import { Markdown } from "../../../shared/chat/Markdown";
import { projectRedlineStream } from "../../lib/redline";
import type { StreamingRedlineEdit } from "../../lib/redline";
import type {
  WordAssistantEvent,
  WordContentEvent,
  WordDocumentReadEvent,
  WordReasoningEvent,
  WordThinkingEvent,
} from "../../types";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";
import { EditCard } from "./EditCard";
import { PreResponseWrapper } from "./PreResponseWrapper";
import { EditCardsSection } from "./message/EditCardsSection";
import {
  DocReadBlock,
  EventBlock,
  ReasoningBlock,
} from "./message/EventBlocks";
import { ResponseStatus, type StatusState } from "./message/ResponseStatus";
import {
  assistantContent,
  assistantError,
  isWordContentEvent,
  isWordDocumentReadEvent,
  isWordReasoningEvent,
  isWordThinkingEvent,
} from "../../lib/wordChatEvents";
import { getEditKey } from "../../lib/wordTrackedEditKeys";
import {
  decodeCitationHref,
  projectCitationMarkdown,
} from "../../lib/citations";
import type {
  EditCardStatus,
  EditDecision,
  EditRuntimeState,
  WordAssistantMessage as WordAssistantTurn,
} from "../../lib/wordChatTypes";

interface AssistantMessageProps {
  message: WordAssistantTurn;
  isStreaming: boolean;
  minHeight?: React.CSSProperties["minHeight"];
  editStateByKey: Readonly<Record<string, EditRuntimeState>>;
  onApplyEdit: (key: string) => void;
  onViewEdit: (key: string) => void;
  onResolveEdit: (key: string, decision: EditDecision) => void;
  onResolveAll: (keys: string[], decision: EditDecision) => void;
  /** Conflicted card: accept the occupying revisions, then apply the edit. */
  onAcceptAndApplyEdit: (key: string) => void;
  /** Scrolls Word to a cited document passage and selects it. */
  onLocateCitation: (text: string) => void;
  activeDocumentName: string;
}

type EventGroup =
  | {
      kind: "pre";
      events: (
        WordThinkingEvent | WordReasoningEvent | WordDocumentReadEvent
      )[];
      indices: number[];
    }
  | {
      kind: "content";
      event: WordContentEvent;
      index: number;
    };

function groupAssistantEvents(events: WordAssistantEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let current: Extract<EventGroup, { kind: "pre" }> | null = null;
  events.forEach((event, index) => {
    if (isWordContentEvent(event)) {
      if (current) {
        groups.push(current);
        current = null;
      }
      groups.push({ kind: "content", event, index });
      return;
    }
    if (
      !isWordThinkingEvent(event) &&
      !isWordReasoningEvent(event) &&
      !isWordDocumentReadEvent(event)
    ) {
      return;
    }
    if (!current) current = { kind: "pre", events: [], indices: [] };
    current.events.push(event);
    current.indices.push(index);
  });
  if (current) groups.push(current);
  return groups;
}

function AssistantMessageImpl({
  message,
  isStreaming,
  minHeight,
  editStateByKey,
  onApplyEdit,
  onViewEdit,
  onResolveEdit,
  onResolveAll,
  onAcceptAndApplyEdit,
  onLocateCitation,
  activeDocumentName,
}: AssistantMessageProps): React.ReactElement {
  // Citation chips render as reserved-fragment links; one delegated handler
  // on each prose block routes their clicks to Word instead of navigation.
  const handleCitationClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const citationControl = target.closest?.("[data-mike-citation]");
      const href =
        citationControl?.getAttribute("data-citation-href") ??
        citationControl?.getAttribute("href");
      if (!href) return;
      const quote = decodeCitationHref(href);
      if (quote === null) return;
      event.preventDefault();
      onLocateCitation(quote);
    },
    [onLocateCitation],
  );
  const content = React.useMemo(() => assistantContent(message), [message]);
  const error = assistantError(message);
  const responseStatus: StatusState = error
    ? "error"
    : isStreaming
      ? "active"
      : null;
  // Re-projecting the full answer is linear in its length; memoize so edit
  // runtime updates (editStateByKey) do not re-parse an unchanged transcript.
  const projection = React.useMemo(
    () => projectRedlineStream(content, !isStreaming),
    [content, isStreaming],
  );
  const edits: StreamingRedlineEdit[] = projection.edits;
  const editRows = edits.map((edit, editIndex) => {
    const key = getEditKey(message.id, edit.blockIndex);
    const runtime = editStateByKey[key];
    const status: EditCardStatus =
      runtime?.status ??
      (message.live ? (edit.sealed ? "applying" : "receiving") : "historical");
    return { edit, editIndex, key, runtime, status };
  });
  const hasUnfinishedEdit = editRows.some(
    ({ status }) =>
      status === "receiving" ||
      status === "validating" ||
      status === "applying" ||
      status === "applying-approved" ||
      status === "restoring",
  );
  const visibleEditRows = editRows.filter(
    ({ status }) =>
      status !== "receiving" &&
      status !== "validating" &&
      status !== "applying" &&
      status !== "restoring",
  );
  const pendingEditCount = visibleEditRows.filter(
    ({ status }) => status === "pending",
  ).length;
  const anyEditBusy = editRows.some(({ runtime }) => runtime?.busy);
  const summaryReady =
    edits.length === 0 || (!isStreaming && !hasUnfinishedEdit);

  const { groups, lastContentEventIndex, contentProjectionByIndex } =
    React.useMemo(() => {
      const eventGroups = groupAssistantEvents(message.events);
      const lastContentIndex = message.events.reduce(
        (last, event, index) => (isWordContentEvent(event) ? index : last),
        -1,
      );
      const projectionByIndex = new Map(
        message.events.flatMap((event, index) =>
          isWordContentEvent(event)
            ? [
                [
                  index,
                  projectRedlineStream(
                    event.text,
                    !isStreaming || index !== lastContentIndex,
                  ),
                ] as const,
              ]
            : [],
        ),
      );
      return {
        groups: eventGroups,
        lastContentEventIndex: lastContentIndex,
        contentProjectionByIndex: projectionByIndex,
      };
    }, [message.events, isStreaming]);
  const editSourceEventIndex = message.events.findIndex(
    (event, index) =>
      isWordContentEvent(event) &&
      (contentProjectionByIndex.get(index)?.edits.length ?? 0) > 0,
  );
  const fallbackEditContentIndex =
    editSourceEventIndex >= 0 ? editSourceEventIndex : lastContentEventIndex;
  const editInsertionGroupIndex =
    edits.length === 0
      ? -1
      : (() => {
          const contentGroupIndex = groups.findIndex(
            (group) =>
              group.kind === "content" &&
              group.index === fallbackEditContentIndex,
          );
          return contentGroupIndex >= 0 ? contentGroupIndex : groups.length;
        })();
  const hasContentAfter = (groupIndex: number): boolean =>
    groups
      .slice(groupIndex + 1)
      .some((group) => group.kind === "content" && group.event.text.length > 0);

  return (
    <div
      className="w-full shrink-0"
      style={minHeight === undefined ? undefined : { minHeight }}
      data-assistant-message-id={message.id}
    >
      <ResponseStatus status={responseStatus} />
      <div className="mt-2 flex flex-col gap-3">
        {groups.map((group, groupIndex) => {
          if (group.kind === "content") {
            const prose =
              contentProjectionByIndex.get(group.index)?.visibleProse ?? "";
            const holdForEdit =
              edits.length > 0 &&
              editInsertionGroupIndex >= 0 &&
              groupIndex >= editInsertionGroupIndex &&
              !summaryReady;
            return (
              <React.Fragment key={`content-${group.event.key ?? group.index}`}>
                {prose && !holdForEdit && (
                  <div
                    className="font-serif text-base leading-7 text-gray-900"
                    onClick={handleCitationClick}
                  >
                    <Markdown className="text-base leading-7">
                      {projectCitationMarkdown(prose, message.citations)}
                    </Markdown>
                  </div>
                )}
              </React.Fragment>
            );
          }

          const groupIsStreaming = group.events.some(
            (event) =>
              isWordThinkingEvent(event) ||
              (isWordReasoningEvent(event) && !!event.isStreaming) ||
              (isWordDocumentReadEvent(event) && event.status === "reading"),
          );
          return (
            <React.Fragment
              key={`pre-${group.events[0]?.key ?? group.indices[0] ?? groupIndex}`}
            >
              <PreResponseWrapper
                stepCount={group.events.length}
                shouldMinimize={hasContentAfter(groupIndex) || !!error}
                isStreaming={groupIsStreaming}
              >
                {group.events.map((event, eventIndex) => {
                  const showConnector = eventIndex < group.events.length - 1;
                  if (isWordReasoningEvent(event)) {
                    return (
                      <ReasoningBlock
                        key={event.key ?? group.indices[eventIndex]}
                        text={event.text}
                        isStreaming={!!event.isStreaming}
                        showConnector={showConnector}
                      />
                    );
                  }
                  if (isWordThinkingEvent(event)) {
                    return (
                      <EventBlock
                        key={event.key ?? group.indices[eventIndex]}
                        showConnector={showConnector}
                        isStreaming
                        dotColor="gray"
                      >
                        Thinking...
                      </EventBlock>
                    );
                  }
                  if (isWordDocumentReadEvent(event)) {
                    return (
                      <DocReadBlock
                        key={event.key ?? group.indices[eventIndex]}
                        filename={
                          event.filename === "Active Word document"
                            ? activeDocumentName
                            : event.filename
                        }
                        isStreaming={event.status === "reading"}
                        showConnector={showConnector}
                      />
                    );
                  }
                  return null;
                })}
              </PreResponseWrapper>
            </React.Fragment>
          );
        })}
        {error && (
          <p
            role="alert"
            className="font-serif text-base leading-7 text-red-600"
          >
            {error}
          </p>
        )}
        {visibleEditRows.length > 0 && (
          <EditCardsSection
            summary={`${visibleEditRows.length} tracked ${visibleEditRows.length === 1 ? "change" : "changes"}`}
            actions={
              pendingEditCount > 0 ? (
                <>
                  <PillButton
                    tone="blue"
                    onClick={() =>
                      onResolveAll(
                        editRows.map(({ key }) => key),
                        "accept",
                      )
                    }
                    disabled={hasUnfinishedEdit || anyEditBusy}
                  >
                    Accept all
                  </PillButton>
                  <PillButton
                    tone="white"
                    onClick={() =>
                      onResolveAll(
                        editRows.map(({ key }) => key),
                        "reject",
                      )
                    }
                    disabled={hasUnfinishedEdit || anyEditBusy}
                  >
                    Reject all
                  </PillButton>
                </>
              ) : undefined
            }
          >
            {visibleEditRows.map(
              ({ edit, editIndex, key, runtime, status }) => (
                <EditCard
                  key={key}
                  edit={edit}
                  changeNumber={editIndex + 1}
                  status={status}
                  matches={runtime?.matches}
                  appliedMatches={runtime?.appliedMatches}
                  locationHint={runtime?.locationHint}
                  error={runtime?.viewError ?? runtime?.error}
                  disabled={!!runtime?.busy}
                  onView={
                    status === "ready" ||
                    status === "pending" ||
                    status === "view-only"
                      ? () => onViewEdit(key)
                      : undefined
                  }
                  onApply={
                    status === "ready" ? () => onApplyEdit(key) : undefined
                  }
                  onAccept={
                    status === "pending"
                      ? () => onResolveEdit(key, "accept")
                      : undefined
                  }
                  onReject={
                    status === "pending"
                      ? () => onResolveEdit(key, "reject")
                      : undefined
                  }
                  onAcceptAndApply={
                    status === "conflicted"
                      ? () => onAcceptAndApplyEdit(key)
                      : undefined
                  }
                />
              ),
            )}
          </EditCardsSection>
        )}
      </div>
    </div>
  );
}

// Streaming commits replace only the live assistant row's message object;
// memoizing here keeps every settled row (and its full Markdown re-parse)
// out of the per-chunk render entirely.
export const AssistantMessage = React.memo(AssistantMessageImpl);
