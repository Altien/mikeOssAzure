import React, { useCallback } from "react";
import { useWordAssistantChat } from "../../hooks/useWordAssistantChat";
import { useWordTrackedEdits } from "../../hooks/useWordTrackedEdits";
import type { Message as SavedMessage } from "../../types";
import {
  createCloudWordDocumentEdit,
  updateCloudWordDocumentEdit,
} from "../../api/mikeApi";
import {
  createLocalWordDocumentEdit,
  updateLocalWordDocumentEdit,
} from "../../lib/localWordChats";
import type {
  WordChatStorageMode,
  WordEditApplyMode,
} from "../../lib/wordChatSettings";
import { ChatView } from "./ChatView";
import type { WorkflowAttachment } from "../../lib/wordChatTypes";

interface ChatPanelProps {
  sessionKey: number;
  chatId: string | null;
  chatModel: string | null;
  lastUsedModel: string | null;
  initialMessages: SavedMessage[];
  selectedWorkflow: WorkflowAttachment | null;
  onSelectedWorkflowChange: (workflow: WorkflowAttachment | null) => void;
  onChatIdChange: (chatId: string) => void;
  onChatStarted: () => void;
  onModelUsed: (model: string) => void;
  wordDocumentId: string;
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
  chatModel,
  lastUsedModel,
  initialMessages,
  selectedWorkflow,
  onSelectedWorkflowChange,
  onChatIdChange,
  onChatStarted,
  onModelUsed,
  wordDocumentId,
  wordChatStorage,
  wordChatOwnerId,
  editApplyMode,
  onEditApplyModeChange,
}: ChatPanelProps): React.ReactElement {
  const persistWordEdit = useCallback(
    async (
      messageId: string,
      blockIndex: number,
      edit: import("../../lib/redline").RedlineEdit,
      applyMode: WordEditApplyMode,
    ) => {
      if (wordChatStorage === "cloud") {
        return createCloudWordDocumentEdit({
          documentId: wordDocumentId,
          messageId,
          blockIndex,
          originalText: edit.original,
          replacementText: edit.replacement,
          formats: edit.format ?? [],
          occurrence: edit.occurrence,
          reason: edit.reason,
          applyMode,
        });
      }
      return createLocalWordDocumentEdit({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        blockIndex,
        originalText: edit.original,
        replacementText: edit.replacement,
        formats: edit.format ?? [],
        occurrence: edit.occurrence,
        reason: edit.reason,
        applyMode,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const updateWordEdit = useCallback(
    async (
      messageId: string,
      blockIndex: number,
      patch: import("../../lib/wordChatTypes").PersistedWordEditPatch,
    ): Promise<void> => {
      if (wordChatStorage === "cloud") {
        await updateCloudWordDocumentEdit({
          documentId: wordDocumentId,
          messageId,
          blockIndex,
          patch,
        });
        return;
      }
      await updateLocalWordDocumentEdit({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        blockIndex,
        patch,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const trackedEdits = useWordTrackedEdits({
    sessionKey,
    initialMessages,
    applyMode: editApplyMode,
    onPersistEdit: persistWordEdit,
    onUpdatePersistedEdit: updateWordEdit,
  });
  const chat = useWordAssistantChat({
    sessionKey,
    chatId,
    initialMessages,
    onChatIdChange,
    onChatStarted,
    onModelUsed,
    wordDocumentId,
    wordChatStorage,
    wordChatOwnerId,
    editApplyMode,
    // Only the identity-stable streaming callbacks; passing the whole
    // controller would tie handleChat's identity to every edit-state change.
    editController: trackedEdits.streamController,
  });

  return (
    <ChatView
      {...chat}
      {...trackedEdits}
      sessionKey={sessionKey}
      chatModel={chatModel}
      lastUsedModel={lastUsedModel}
      selectedWorkflow={selectedWorkflow}
      onSelectedWorkflowChange={onSelectedWorkflowChange}
      editApplyMode={editApplyMode}
      onEditApplyModeChange={onEditApplyModeChange}
    />
  );
}
