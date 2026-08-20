import React, { useCallback, useRef } from "react";
import { useWordAssistantChat } from "../../hooks/useWordAssistantChat";
import { useWordTrackedEdits } from "../../hooks/useWordTrackedEdits";
import type {
  Message as SavedMessage,
  WordEditDecisionStatus,
} from "../../types";
import { updateCloudWordEditDecisions } from "../../api/mikeApi";
import { updateLocalWordEditDecisions } from "../../lib/localWordChats";
import type {
  WordChatStorageMode,
  WordEditApplyMode,
} from "../../lib/wordChatSettings";
import { ChatView } from "./ChatView";
import type { WorkflowAttachment } from "../../lib/wordChatTypes";

interface ChatPanelProps {
  sessionKey: number;
  chatId: string | null;
  initialMessages: SavedMessage[];
  selectedWorkflow: WorkflowAttachment | null;
  onSelectedWorkflowChange: (workflow: WorkflowAttachment | null) => void;
  onChatIdChange: (chatId: string) => void;
  onChatStarted: () => void;
  wordDocumentId: string;
  activeDocumentName: string;
  wordChatStorage: WordChatStorageMode;
  wordChatOwnerId: string;
  editApplyMode: WordEditApplyMode;
  onEditApplyModeChange: (mode: WordEditApplyMode) => void;
}

/**
 * Word's equivalent of the frontend assistant page: compose the stateful chat
 * and tracked-edit controllers, then hand both to the view. Office handles,
 * transport code, message rendering, and composer state live below this seam.
 */
export function ChatPanel({
  sessionKey,
  chatId,
  initialMessages,
  selectedWorkflow,
  onSelectedWorkflowChange,
  onChatIdChange,
  onChatStarted,
  wordDocumentId,
  activeDocumentName,
  wordChatStorage,
  wordChatOwnerId,
  editApplyMode,
  onEditApplyModeChange,
}: ChatPanelProps): React.ReactElement {
  const pendingEditDecisionsRef = useRef(
    new Map<string, Record<string, WordEditDecisionStatus>>(),
  );
  const persistEditDecisions = useCallback(
    async (
      messageId: string,
      decisions: Record<string, WordEditDecisionStatus>,
    ): Promise<void> => {
      const merged = {
        ...(pendingEditDecisionsRef.current.get(messageId) ?? {}),
        ...decisions,
      };
      pendingEditDecisionsRef.current.set(messageId, merged);
      if (wordChatStorage === "cloud") {
        await updateCloudWordEditDecisions(
          wordDocumentId,
          messageId,
          decisions,
        );
        return;
      }
      await updateLocalWordEditDecisions({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        decisions,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const getEditDecisionsForMessage = useCallback(
    (messageId: string) => pendingEditDecisionsRef.current.get(messageId),
    [],
  );
  const flushLocalEditDecisions = useCallback(
    async (messageId: string): Promise<void> => {
      if (wordChatStorage !== "local") return;
      const decisions = pendingEditDecisionsRef.current.get(messageId);
      if (!decisions) return;
      await updateLocalWordEditDecisions({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        decisions,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const trackedEdits = useWordTrackedEdits({
    sessionKey,
    initialMessages,
    applyMode: editApplyMode,
    onPersistEditDecisions: persistEditDecisions,
  });
  const chat = useWordAssistantChat({
    sessionKey,
    chatId,
    initialMessages,
    onChatIdChange,
    onChatStarted,
    wordDocumentId,
    wordChatStorage,
    wordChatOwnerId,
    getEditDecisionsForMessage,
    onAssistantMessageSaved: flushLocalEditDecisions,
    // Only the identity-stable streaming callbacks; passing the whole
    // controller would tie handleChat's identity to every edit-state change.
    editController: trackedEdits.streamController,
  });

  return (
    <ChatView
      {...chat}
      {...trackedEdits}
      sessionKey={sessionKey}
      selectedWorkflow={selectedWorkflow}
      onSelectedWorkflowChange={onSelectedWorkflowChange}
      editApplyMode={editApplyMode}
      onEditApplyModeChange={onEditApplyModeChange}
      activeDocumentName={activeDocumentName}
    />
  );
}
