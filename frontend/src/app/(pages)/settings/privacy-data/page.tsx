"use client";

import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
  PERSONAL_WORKSPACE,
  PERSONAL_WORKSPACE_LABEL,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { useHasMultipleWorkspaces } from "@/app/hooks/useHasMultipleWorkspaces";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";
// Dev (sync-log: 040e17ac): Entra controls MFA; original actor/workspace guards remain at every request.
import {
  deleteAllChats,
  deleteAllMemories,
  deleteAllProjects,
  deleteAllTabularReviews,
  downloadUserExport,
  getUserExportStatus,
  startUserExport,
  type UserExportType,
} from "@/app/lib/mikeApi";
import { UserVisibleError, notifyError } from "@/app/lib/userFacingError";

type DeleteDataAction = "chats" | "tabular-reviews" | "projects" | "memory";
type ExportDataAction =
  | "export-chats"
  | "export-tabular-reviews"
  | "export-account"
  | "export-memory";
type MfaRetryAction = DeleteDataAction | ExportDataAction;

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

/**
 * The confirmation for deleting data in one workspace. Each "Delete all"
 * reaches the active workspace only. `workspaceName` is set when the person
 * has more than one workspace, and the copy then says which; with only
 * Personal there is nothing to tell apart, and it names none.
 */
function deleteDataCopy(
  action: DeleteDataAction,
  personal: boolean,
  workspaceName: string | null,
): { title: string; message: string } {
  const where = workspaceName ? ` in ${workspaceName}` : "";
  const others = workspaceName ? " Your other workspaces are not affected." : "";
  const undo = "This action cannot be undone.";
  switch (action) {
    case "chats":
      return {
        title: `Delete all chats${where}?`,
        message: `This will permanently delete your assistant and tabular review chat history${where}.${others} ${undo}`,
      };
    case "tabular-reviews":
      return {
        title: `Delete all tabular reviews${where}?`,
        message: `This will permanently delete all tabular reviews you own${where}, including their cells and review chats.${others} ${undo}`,
      };
    case "projects":
      return {
        title: `Delete all projects${where}?`,
        message: personal
          ? `This will permanently delete all projects you own${where}, including their documents, chats, and tabular reviews.${others} ${undo}`
          : `This will permanently delete all projects you created${where}, including their documents, chats, and tabular reviews. Colleagues lose them too.${others} ${undo}`,
      };
    case "memory":
      return {
        title: `Delete all memory${where}?`,
        message: personal
          ? `This permanently deletes your ${workspaceName ? `${workspaceName} memory` : "app memory"} and memories for private projects you created. Project collaborators will also lose those memories.${others} Memory remains enabled and can be rebuilt from future conversations. ${undo}`
          : `This permanently deletes your memory${where}. Project memories there are not affected, and neither are your other workspaces. Memory remains enabled and can be rebuilt from future conversations. ${undo}`,
      };
  }
}

/** Imperative, lower case: "Couldn't delete your chats". */
const DELETE_ACTION_LABELS: Record<DeleteDataAction, string> = {
  chats: "delete your chats",
  "tabular-reviews": "delete your tabular reviews",
  projects: "delete your projects",
  memory: "delete your memory",
};

// Deletion works on the active workspace. Keyed by it, so switching
// workspace drops a confirmation or verification still open for the old one
// rather than carrying it into the new one.
export default function PrivacyDataPage() {
  const { workspaceId, activeOrganization } = useWorkspace();
  const multipleWorkspaces = useHasMultipleWorkspaces();
  const workspace = workspaceId ?? PERSONAL_WORKSPACE;
  return (
    <PrivacyData
      key={workspace}
      workspace={workspace}
      workspaceName={
        multipleWorkspaces
          ? (activeOrganization?.name ?? PERSONAL_WORKSPACE_LABEL)
          : null
      }
    />
  );
}

function PrivacyData({
  workspace,
  workspaceName,
}: {
  /** "personal" or an organization id. */
  workspace: string;
  /** The workspace's name when the person has more than one, else null. */
  workspaceName: string | null;
}) {
  const requestOwner = useRequestOwner();
  const { loadChats, setCurrentChatId } = useChatHistoryContext();
  const [pendingDeleteAction, setPendingDeleteAction] =
    useState<DeleteDataAction | null>(null);
  const [deletingAction, setDeletingAction] = useState<DeleteDataAction | null>(
    null,
  );
  const [isExportingAccount, setIsExportingAccount] = useState(false);
  const [isExportingChats, setIsExportingChats] = useState(false);
  const [isExportingTabularReviews, setIsExportingTabularReviews] =
    useState(false);
  const [isExportingMemory, setIsExportingMemory] = useState(false);

    const downloadBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

  // Exports run as durable backend jobs: schedule, poll until built, then
  // download the artifact. A double click dedupes onto the running job
  // server-side, and a build that outlives this tab can be re-downloaded by
  // clicking the button again (the poll finds the finished job).
  const EXPORT_POLL_MS = process.env.NODE_ENV === "test" ? 10 : 2000;
  const EXPORT_POLL_LIMIT = 150; // ~5 minutes
    const runAsyncExport = async (
        type: UserExportType,
        fallbackFilename: string,
        isCurrent: () => boolean,
    ) => {
        const { export_id } = await startUserExport(type, undefined, isCurrent);
        for (let i = 0; i < EXPORT_POLL_LIMIT; i++) {
            await new Promise((resolve) =>
                setTimeout(resolve, EXPORT_POLL_MS),
            );
            const status = await getUserExportStatus(export_id, isCurrent);
            if (status.status === "failed")
                throw new UserVisibleError("Mike could not build the export. Try again, and contact support if it keeps happening.", { retryable: true });
            if (status.status === "done") {
                const { blob, filename } = await downloadUserExport(export_id, isCurrent);
                if (!isCurrent()) return;
                downloadBlob(
                    blob,
                    filename ?? status.filename ?? fallbackFilename,
                );
                return;
            }
        }
        throw new UserVisibleError("The export is taking longer than expected. It may still be building, so try again in a few minutes.", { retryable: true });
    };

    const handleExportAccountData = async () => {
        const isCurrent = requestOwner.capture();
        if (!isCurrent()) return;
        devLog("[privacy-data] export account requested");
        setIsExportingAccount(true);
        try {
            await runAsyncExport("account", "mike-account-export.json", isCurrent);
        } catch (error) {
            devLog("[privacy-data] export account failed", { error });
            if (isCurrent()) notifyError(error, { action: "export your account data", onRetry: () => { if (isCurrent()) void handleExportAccountData(); } });
        } finally {
            setIsExportingAccount(false);
        }
    };

    const handleExportChatData = async () => {
        const isCurrent = requestOwner.capture();
        if (!isCurrent()) return;
        devLog("[privacy-data] export chats requested");
        setIsExportingChats(true);
        try {
            await runAsyncExport("chats", "mike-chat-export.json", isCurrent);
        } catch (error) {
            devLog("[privacy-data] export chats failed", { error });
            if (isCurrent()) notifyError(error, { action: "export your chats", onRetry: () => { if (isCurrent()) void handleExportChatData(); } });
        } finally {
            setIsExportingChats(false);
        }
    };

    const handleExportTabularReviewsData = async () => {
        const isCurrent = requestOwner.capture();
        if (!isCurrent()) return;
        devLog("[privacy-data] export tabular reviews requested");
        setIsExportingTabularReviews(true);
        try {
            await runAsyncExport("tabular-reviews", "mike-tabular-reviews-export.json", isCurrent);
        } catch (error) {
            devLog("[privacy-data] export tabular reviews failed", { error });
            if (isCurrent()) notifyError(error, { action: "export your tabular reviews", onRetry: () => { if (isCurrent()) void handleExportTabularReviewsData(); } });
        } finally {
            setIsExportingTabularReviews(false);
        }
    };

    const handleExportMemoryData = async () => {
        const isCurrent = requestOwner.capture();
        if (!isCurrent()) return;
        devLog("[privacy-data] export memory requested");
        setIsExportingMemory(true);
        try {
            await runAsyncExport("memory-zip", "mike-memory-export.zip", isCurrent);
        } catch (error) {
            devLog("[privacy-data] export memory failed", { error });
            if (isCurrent()) notifyError(error, { action: "export your memory", onRetry: () => { if (isCurrent()) void handleExportMemoryData(); } });
        } finally {
            setIsExportingMemory(false);
        }
    };

    const handleDeleteData = async (action: DeleteDataAction) => {
        const isCurrent = requestOwner.capture();
        if (!isCurrent()) return;
        devLog("[privacy-data] delete requested", { action });
        setDeletingAction(action);
        try {
            if (action === "chats") {
                await deleteAllChats(workspace, isCurrent);
                if (!isCurrent()) return;
                setCurrentChatId(null);
                await loadChats();
            } else if (action === "tabular-reviews") {
                await deleteAllTabularReviews(workspace, isCurrent);
                if (!isCurrent()) return;
            } else if (action === "memory") {
                await deleteAllMemories(workspace, isCurrent);
                if (!isCurrent()) return;
            } else {
                await deleteAllProjects(workspace, isCurrent);
                if (!isCurrent()) return;
                setCurrentChatId(null);
                await loadChats();
            }
            setPendingDeleteAction(null);
        } catch (error) {
            devLog("[privacy-data] delete failed", { action, error });
            if (isCurrent()) notifyError(error, { action: DELETE_ACTION_LABELS[action], onRetry: () => { if (isCurrent()) setPendingDeleteAction(action); } });
        } finally {
            setDeletingAction(null);
        }
    };



  const personal = workspace === PERSONAL_WORKSPACE;
  const pendingDeleteCopy = pendingDeleteAction
    ? deleteDataCopy(pendingDeleteAction, personal, workspaceName)
    : null;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>Export data</SettingsHeading>
        <GlassCardUI>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export chats</SettingsLabel>
              <SettingsDescription>
                Download assistant and tabular review chat history as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportChatData}
              disabled={isExportingChats}
              loading={isExportingChats}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingChats ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export tabular reviews</SettingsLabel>
              <SettingsDescription>
                Download all owned tabular reviews, cells, and review chat
                records as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportTabularReviewsData}
              disabled={isExportingTabularReviews}
              loading={isExportingTabularReviews}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingTabularReviews ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export account JSON</SettingsLabel>
              <SettingsDescription>
                Download account metadata, projects, document metadata,
                workflows, playbooks, and review data as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportAccountData}
              disabled={isExportingAccount}
              loading={isExportingAccount}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingAccount ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export memory</SettingsLabel>
              <SettingsDescription>
                Download your app memory and every project memory you can access
                as Markdown files in a ZIP archive.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              aria-label="Export memory"
              onClick={handleExportMemoryData}
              disabled={isExportingMemory}
              loading={isExportingMemory}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingMemory ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
        </GlassCardUI>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Delete data</SettingsHeading>
        {workspaceName && (
          <SettingsDescription>
            Deletes data in {workspaceName} only. To delete data in another
            workspace, switch to it first.
          </SettingsDescription>
        )}
        <GlassCardUI>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all chats</SettingsLabel>
              <SettingsDescription>
                Permanently delete your assistant and tabular review chat
                history.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("chats")}
              disabled={!!deletingAction}
              loading={deletingAction === "chats"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all tabular reviews</SettingsLabel>
              <SettingsDescription>
                Permanently delete all tabular reviews you own, including cells
                and review chats.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("tabular-reviews")}
              disabled={!!deletingAction}
              loading={deletingAction === "tabular-reviews"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all projects</SettingsLabel>
              <SettingsDescription>
                {personal
                  ? "Permanently delete all projects you own, including documents, chats, and tabular reviews."
                  : "Permanently delete all projects you created here, including documents, chats, and tabular reviews."}
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("projects")}
              disabled={!!deletingAction}
              loading={deletingAction === "projects"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all memory</SettingsLabel>
              <SettingsDescription>
                {!personal
                  ? `Permanently delete your memory in ${workspaceName ?? "this workspace"}.`
                  : workspaceName
                    ? `Permanently delete your ${workspaceName} memory and memories for private projects you created.`
                    : "Permanently delete your app memory and memories for private projects you created."}
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              aria-label="Delete all memory"
              onClick={() => setPendingDeleteAction("memory")}
              disabled={!!deletingAction}
              loading={deletingAction === "memory"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
        </GlassCardUI>
      </section>
      <ConfirmPopup
        open={!!pendingDeleteAction}
        title={pendingDeleteCopy?.title}
        message={pendingDeleteCopy?.message}
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={deletingAction ? "loading" : "idle"}
        cancelLabel="Cancel"
        onCancel={() => {
          if (deletingAction) return;
          setPendingDeleteAction(null);
        }}
        onConfirm={() => {
          if (!pendingDeleteAction) return;
          void handleDeleteData(pendingDeleteAction);
        }}
      />
    </div>
  );
}
