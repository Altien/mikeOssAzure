import React from "react";
import { useWordAssistantChat } from "../../hooks/useWordAssistantChat";
import { useWordTrackedEdits } from "../../hooks/useWordTrackedEdits";
import type { Message as SavedMessage } from "../../types";
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
  wordChatStorage,
  wordChatOwnerId,
  editApplyMode,
  onEditApplyModeChange,
}: ChatPanelProps): React.ReactElement {
  const trackedEdits = useWordTrackedEdits({
    sessionKey,
    initialMessages,
    applyMode: editApplyMode,
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
    />
  );
}
