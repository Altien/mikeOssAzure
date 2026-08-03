import React, { useState, useRef, useEffect } from "react";
import { MessageSquareText } from "lucide-react";
import { streamAssistant } from "../api/stream";
import { useWordDoc } from "../hooks/useWordDoc";
import { parseRedlineEdits, REDLINE_FORMAT } from "../lib/redline";
import { UserBubble, AssistantBubble } from "@mike/shared/chat/ChatBubble";
import { ChatInput } from "@mike/shared/chat/ChatInput";
import { Button } from "@mike/shared/ui/button";
import { Switch } from "@mike/shared/ui/switch";
import { Spinner } from "@mike/shared/ui/spinner";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Appended to the outgoing user turn (never shown in the transcript) while
// "Suggest tracked edits" is on, so the answer parses into applyable edits.
const REDLINE_CHAT_INSTRUCTION = `\n\nWhen your answer proposes changes to existing document text: ${REDLINE_FORMAT} You may explain your reasoning in prose around the items.`;

export function ChatPanel(): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [useDocContext, setUseDocContext] = useState(false);
  const [redlineMode, setRedlineMode] = useState(false);
  const [applyByIndex, setApplyByIndex] = useState<
    Record<number, { busy: boolean; summary: string | null }>
  >({});
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
      { role: "assistant", content: "" },
    ];
    setMessages(withPlaceholder);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAssistant(
        { messages: apiHistory, documentContext, signal: controller.signal },
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
      [index]: { busy: true, summary: null },
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
        [index]: { busy: false, summary: parts.join(" ") },
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
              return <UserBubble key={i} content={msg.content} />;
            }
            // Only completed answers are parsed: applying a half-streamed
            // edit could redline the document with a truncated replacement.
            const isComplete = !streaming || i < messages.length - 1;
            const edits =
              isComplete && msg.content ? parseRedlineEdits(msg.content) : [];
            const applyState = applyByIndex[i];
            return (
              <AssistantBubble
                key={i}
                content={msg.content}
                actions={
                  msg.content ? (
                    <>
                      {edits.length > 0 && (
                        <Button
                          size="sm"
                          onClick={() => void applyMessageEdits(i, msg.content)}
                          disabled={applyState?.busy}
                        >
                          {applyState?.busy
                            ? "Applying…"
                            : `Apply ${edits.length} tracked edit${edits.length === 1 ? "" : "s"}`}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void insertBelowSelection(msg.content)}
                      >
                        Insert below cursor
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void insertBelowSelection(msg.content, true)}
                      >
                        Insert below (tracked)
                      </Button>
                      {applyState?.summary && (
                        <p
                          role="status"
                          className="w-full text-xs text-muted-foreground"
                        >
                          {applyState.summary}
                        </p>
                      )}
                    </>
                  ) : undefined
                }
              />
            );
          })}
          {streaming && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              <span>Thinking…</span>
            </div>
          )}
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
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                <Switch
                  checked={useDocContext || redlineMode}
                  onCheckedChange={(v) => setUseDocContext(!!v)}
                  disabled={streaming || redlineMode}
                  aria-label="Use document as context"
                />
                <span className="truncate">Use document as context</span>
              </label>
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                <Switch
                  checked={redlineMode}
                  onCheckedChange={(v) => setRedlineMode(!!v)}
                  disabled={streaming}
                  aria-label="Suggest tracked edits"
                />
                <span className="truncate">Suggest tracked edits</span>
              </label>
            </div>
          }
        />
      </div>
    </div>
  );
}
