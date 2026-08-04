import React, { useState, useRef, useEffect } from "react";
import { MessageSquareText } from "lucide-react";
import { streamAssistant } from "../api/stream";
import { useWordDoc } from "../hooks/useWordDoc";
import type { RedlineApplyReport } from "../hooks/useWordDoc";
import {
  parseRedlineEdits,
  stripRedlineBlocks,
  REDLINE_FORMAT,
} from "../lib/redline";
import { Markdown } from "@mike/shared/chat/Markdown";
import { ChatInput } from "@mike/shared/chat/ChatInput";
import { ToggleSwitch } from "@mike/shared/ui/toggle-switch";
import { UserMessage } from "./assistant/UserMessage";
import { PreResponseWrapper } from "./assistant/PreResponseWrapper";
import { DocReadBlock, DocFindBlock, EventBlock } from "./assistant/EventBlocks";
import { EditCard } from "./assistant/EditCard";
import { EditCardsSection } from "./assistant/EditCardsSection";
import { PillButton } from "./assistant/PillButton";

interface Message {
  role: "user" | "assistant";
  content: string;
  /**
   * Assistant turns only: the pane read the live document before asking the
   * model (doc-context or redline mode) — rendered as a "Read" event in the
   * pre-response strip, mirroring the web app.
   */
  docRead?: boolean;
}

// Appended to the outgoing user turn (never shown in the transcript) while
// "Suggest tracked edits" is on, so the answer parses into applyable edits.
const REDLINE_CHAT_INSTRUCTION = `\n\nWhen your answer proposes changes to existing document text: ${REDLINE_FORMAT} You may explain your reasoning in prose around the items.`;

interface ApplyState {
  busy: boolean;
  summary: string | null;
  /** Per-edit Word search results from the last apply (drives "Found" rows). */
  found: RedlineApplyReport["found"] | null;
}

export function ChatPanel(): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [useDocContext, setUseDocContext] = useState(false);
  const [redlineMode, setRedlineMode] = useState(false);
  const [applyByIndex, setApplyByIndex] = useState<Record<number, ApplyState>>(
    {}
  );
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const { readDocumentText, insertBelowSelection, applyTrackedEdits } =
    useWordDoc();

  // Auto-scroll on new content
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Abort any in-flight stream when the panel unmounts (e.g. switching tabs) so
  // we neither keep the connection open nor setState on an unmounted component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleCancel = (): void => abortRef.current?.abort();

  const handleSend = async (): Promise<void> => {
    const text = input.trim();
    if (!text || streaming) return;

    let documentContext: string | undefined;
    // Redline mode is meaningless without the document text: the model must
    // copy ORIGINAL snippets verbatim from it for the edits to be findable.
    if (useDocContext || redlineMode) {
      try {
        documentContext = await readDocumentText();
      } catch {
        documentContext = undefined;
      }
    }

    const userMsg: Message = { role: "user", content: text };
    const history: Message[] = [...messages, userMsg];
    // The transcript shows what the user typed; the request carries the
    // format contract so the answer parses into applyable edits.
    const apiHistory: Message[] = redlineMode
      ? [
          ...messages,
          { role: "user", content: text + REDLINE_CHAT_INSTRUCTION },
        ]
      : history;

    setMessages(history);
    setInput("");
    setStreaming(true);

    // Append empty assistant slot so the user sees it filling in
    const withPlaceholder: Message[] = [
      ...history,
      { role: "assistant", content: "", docRead: documentContext !== undefined },
    ];
    setMessages(withPlaceholder);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAssistant(
        {
          messages: apiHistory.map(({ role, content }) => ({ role, content })),
          documentContext,
          signal: controller.signal,
        },
        (chunk) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                content: last.content + chunk,
              };
            }
            return next;
          });
        }
      );
    } catch (e) {
      // A user-initiated stop or an unmount aborts the request — keep whatever
      // partial answer streamed in, don't render it as an error.
      if (controller.signal.aborted || !mountedRef.current) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            content:
              e instanceof Error ? `Error: ${e.message}` : "An error occurred.",
          };
        }
        return next;
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setStreaming(false);
    }
  };

  const applyMessageEdits = async (index: number, content: string): Promise<void> => {
    const edits = parseRedlineEdits(content);
    if (edits.length === 0) return;
    setApplyByIndex((prev) => ({
      ...prev,
      [index]: { busy: true, summary: null, found: null },
    }));
    try {
      const report = await applyTrackedEdits(edits);
      const parts = [
        `Applied ${report.applied} of ${edits.length} edit${edits.length === 1 ? "" : "s"} as tracked changes.`,
      ];
      if (report.skipped.length > 0) {
        parts.push(
          `${report.skipped.length} skipped — the quoted text was not found in the document.`
        );
      }
      setApplyByIndex((prev) => ({
        ...prev,
        [index]: { busy: false, summary: parts.join(" "), found: report.found },
      }));
    } catch (error) {
      setApplyByIndex((prev) => ({
        ...prev,
        [index]: {
          busy: false,
          summary:
            error instanceof Error
              ? error.message
              : "Word couldn't apply the changes.",
          found: null,
        },
      }));
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Message list */}
      {!hasMessages && !streaming ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquareText className="size-6" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Ask anything about your document
            </p>
            <p className="text-xs text-muted-foreground">
              Mike can summarize, explain, and draft — toggle document context
              below to ground answers in your file.
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={listRef}
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 @sm:px-4"
        >
          {messages.map((msg, i) => {
            if (msg.role === "user") {
              return <UserMessage key={i} content={msg.content} />;
            }
            const isLast = i === messages.length - 1;
            const streamingThis = streaming && isLast;
            // Only completed answers are parsed: applying a half-streamed
            // edit could redline the document with a truncated replacement.
            const isComplete = !streamingThis;
            const edits =
              isComplete && msg.content ? parseRedlineEdits(msg.content) : [];
            const prose =
              edits.length > 0 ? stripRedlineBlocks(msg.content) : msg.content;
            const applyState = applyByIndex[i];
            const waitingForAnswer = streamingThis && !msg.content;
            return (
              <div key={i} className="flex w-full flex-col gap-3">
                {/* Pre-response activity strip (matches the web assistant). */}
                {(msg.docRead || waitingForAnswer) && (
                  <PreResponseWrapper
                    stepCount={msg.docRead ? 1 : 0}
                    shouldMinimize={!!msg.content}
                    isStreaming={waitingForAnswer}
                  >
                    {msg.docRead ? (
                      <DocReadBlock
                        filename="Current document"
                        isStreaming={waitingForAnswer}
                      />
                    ) : (
                      <EventBlock isStreaming dotColor="gray">
                        Thinking...
                      </EventBlock>
                    )}
                  </PreResponseWrapper>
                )}
                {prose && (
                  <div className="font-serif text-[15px] leading-relaxed text-gray-900">
                    <Markdown>{prose}</Markdown>
                  </div>
                )}
                {edits.length > 0 && (
                  <EditCardsSection
                    summary={`${edits.length} tracked ${edits.length === 1 ? "change" : "changes"}`}
                    actions={
                      <PillButton
                        tone="black"
                        onClick={() => void applyMessageEdits(i, msg.content)}
                        disabled={applyState?.busy}
                      >
                        {applyState?.busy
                          ? "Applying…"
                          : `Apply ${edits.length} tracked edit${edits.length === 1 ? "" : "s"}`}
                      </PillButton>
                    }
                    status={
                      (applyState?.summary || applyState?.found) && (
                        <div className="flex flex-col gap-2">
                          {applyState?.found?.map((f, j) => (
                            <DocFindBlock
                              key={j}
                              query={f.original}
                              totalMatches={f.matches}
                              filename="the document"
                              showConnector={j < applyState.found!.length - 1}
                            />
                          ))}
                          {applyState?.summary && (
                            <p
                              role="status"
                              className="text-xs font-serif text-gray-500"
                            >
                              {applyState.summary}
                            </p>
                          )}
                        </div>
                      )
                    }
                  >
                    {edits.map((edit, j) => (
                      <EditCard key={j} edit={edit} changeNumber={j + 1} />
                    ))}
                  </EditCardsSection>
                )}
                {msg.content && isComplete && (
                  <div className="flex flex-wrap gap-2">
                    <PillButton
                      tone="white"
                      onClick={() => void insertBelowSelection(msg.content)}
                    >
                      Insert below cursor
                    </PillButton>
                    <PillButton
                      tone="white"
                      onClick={() => void insertBelowSelection(msg.content, true)}
                    >
                      Insert below (tracked)
                    </PillButton>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-border/70 p-3 @sm:p-4">
        <ChatInput
          value={input}
          onValueChange={setInput}
          onSubmit={() => void handleSend()}
          isLoading={streaming}
          onCancel={handleCancel}
          disabled={streaming}
          placeholder="Ask Mike…"
          leftSlot={
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <ToggleSwitch
                checked={useDocContext || redlineMode}
                onCheckedChange={(v) => setUseDocContext(v)}
                disabled={streaming || redlineMode}
                aria-label="Use document as context"
                className="min-w-0 gap-2 text-xs"
              >
                Use document as context
              </ToggleSwitch>
              <ToggleSwitch
                checked={redlineMode}
                onCheckedChange={(v) => setRedlineMode(v)}
                disabled={streaming}
                aria-label="Suggest tracked edits"
                className="min-w-0 gap-2 text-xs"
              >
                Suggest tracked edits
              </ToggleSwitch>
            </div>
          }
        />
      </div>
    </div>
  );
}
