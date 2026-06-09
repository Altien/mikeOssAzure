"use client";

import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
// Upstream divergence (sync-log: 3a10943): upstream wraps these actions in
// a Supabase Auth MFA step-up flow (MfaVerificationPopup +
// needsMfaVerification + isMfaRequiredError retries). Dev did not adopt
// app-level Supabase MFA — Entra enforces MFA at the IdP — so the actions
// run directly after the confirm popup.
import {
    deleteAllChats,
    deleteAllProjects,
    deleteAllTabularReviews,
    exportAccountData,
    exportChatData,
    exportTabularReviewsData,
} from "@/app/lib/mikeApi";
import {
    accountGlassDangerOutlineButtonClassName,
    accountGlassPrimaryButtonClassName,
    accountGlassSectionClassName,
} from "../accountStyles";

type DeleteDataAction = "chats" | "tabular-reviews" | "projects";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

const DELETE_DATA_COPY: Record<
    DeleteDataAction,
    {
        title: string;
        message: string;
    }
> = {
    chats: {
        title: "Delete all chats?",
        message:
            "This will permanently delete your assistant and tabular review chat history. This action cannot be undone.",
    },
    "tabular-reviews": {
        title: "Delete all tabular reviews?",
        message:
            "This will permanently delete all tabular reviews you own, including their cells and review chats. This action cannot be undone.",
    },
    projects: {
        title: "Delete all projects?",
        message:
            "This will permanently delete all projects you own, including their documents, chats, and tabular reviews. This action cannot be undone.",
    },
};

export default function PrivacyDataPage() {
    const { loadChats, setCurrentChatId } = useChatHistoryContext();
    const [pendingDeleteAction, setPendingDeleteAction] =
        useState<DeleteDataAction | null>(null);
    const [deletingAction, setDeletingAction] =
        useState<DeleteDataAction | null>(null);
    const [isExportingAccount, setIsExportingAccount] = useState(false);
    const [isExportingChats, setIsExportingChats] = useState(false);
    const [isExportingTabularReviews, setIsExportingTabularReviews] =
        useState(false);

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

    const handleExportAccountData = async () => {
        devLog("[privacy-data] export account requested");
        setIsExportingAccount(true);
        try {
            const { blob, filename } = await exportAccountData();
            downloadBlob(blob, filename ?? "mike-account-export.json");
        } catch (error) {
            devLog("[privacy-data] export account failed", { error });
            alert("Failed to export account data. Please try again.");
        } finally {
            setIsExportingAccount(false);
        }
    };

    const handleExportChatData = async () => {
        devLog("[privacy-data] export chats requested");
        setIsExportingChats(true);
        try {
            const { blob, filename } = await exportChatData();
            downloadBlob(blob, filename ?? "mike-chat-export.json");
        } catch (error) {
            devLog("[privacy-data] export chats failed", { error });
            alert("Failed to export chats. Please try again.");
        } finally {
            setIsExportingChats(false);
        }
    };

    const handleExportTabularReviewsData = async () => {
        devLog("[privacy-data] export tabular reviews requested");
        setIsExportingTabularReviews(true);
        try {
            const { blob, filename } = await exportTabularReviewsData();
            downloadBlob(blob, filename ?? "mike-tabular-reviews-export.json");
        } catch (error) {
            devLog("[privacy-data] export tabular reviews failed", { error });
            alert("Failed to export tabular reviews. Please try again.");
        } finally {
            setIsExportingTabularReviews(false);
        }
    };

    const handleDeleteData = async (action: DeleteDataAction) => {
        devLog("[privacy-data] delete requested", { action });
        setDeletingAction(action);
        try {
            if (action === "chats") {
                await deleteAllChats();
                setCurrentChatId(null);
                await loadChats();
            } else if (action === "tabular-reviews") {
                await deleteAllTabularReviews();
            } else {
                await deleteAllProjects();
                setCurrentChatId(null);
                await loadChats();
            }
            setPendingDeleteAction(null);
        } catch (error) {
            devLog("[privacy-data] delete failed", { action, error });
            alert("Failed to delete data. Please try again.");
        } finally {
            setDeletingAction(null);
        }
    };

    const pendingDeleteCopy = pendingDeleteAction
        ? DELETE_DATA_COPY[pendingDeleteAction]
        : null;

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Export data
                </h2>
                <div className={accountGlassSectionClassName}>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Export chats
                            </p>
                            <p className="text-sm text-gray-500">
                                Download assistant and tabular review chat
                                history as JSON.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={handleExportChatData}
                            disabled={isExportingChats}
                            className={`h-9 gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}
                        >
                            {!isExportingChats && (
                                <Download className="h-4 w-4 shrink-0" />
                            )}
                            {isExportingChats ? "Exporting..." : "Export"}
                        </Button>
                    </div>
                    <div className="mx-4 h-px bg-gray-200" />

                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Export tabular reviews
                            </p>
                            <p className="text-sm text-gray-500">
                                Download all owned tabular reviews, cells, and
                                review chat records as JSON.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={handleExportTabularReviewsData}
                            disabled={isExportingTabularReviews}
                            className={`h-9 gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}
                        >
                            {!isExportingTabularReviews && (
                                <Download className="h-4 w-4 shrink-0" />
                            )}
                            {isExportingTabularReviews
                                ? "Exporting..."
                                : "Export"}
                        </Button>
                    </div>
                    <div className="mx-4 h-px bg-gray-200" />

                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Export account JSON
                            </p>
                            <p className="text-sm text-gray-500">
                                Download account metadata, projects, document
                                metadata, workflows, and review data as JSON.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={handleExportAccountData}
                            disabled={isExportingAccount}
                            className={`h-9 gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}
                        >
                            {!isExportingAccount && (
                                <Download className="h-4 w-4 shrink-0" />
                            )}
                            {isExportingAccount ? "Exporting..." : "Export"}
                        </Button>
                    </div>
                </div>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Delete data
                </h2>
                <div className={accountGlassSectionClassName}>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Delete all chats
                            </p>
                            <p className="text-sm text-gray-500">
                                Permanently delete your assistant and tabular
                                review chat history.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={() => setPendingDeleteAction("chats")}
                            disabled={!!deletingAction}
                            className={`h-9 w-full shrink-0 gap-1.5 sm:w-auto ${accountGlassDangerOutlineButtonClassName}`}
                        >
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Delete
                        </Button>
                    </div>
                    <div className="mx-4 h-px bg-gray-200" />

                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Delete all tabular reviews
                            </p>
                            <p className="text-sm text-gray-500">
                                Permanently delete all tabular reviews you own,
                                including cells and review chats.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={() =>
                                setPendingDeleteAction("tabular-reviews")
                            }
                            disabled={!!deletingAction}
                            className={`h-9 w-full shrink-0 gap-1.5 sm:w-auto ${accountGlassDangerOutlineButtonClassName}`}
                        >
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Delete
                        </Button>
                    </div>
                    <div className="mx-4 h-px bg-gray-200" />

                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-900">
                                Delete all projects
                            </p>
                            <p className="text-sm text-gray-500">
                                Permanently delete all projects you own,
                                including documents, chats, and tabular reviews.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={() => setPendingDeleteAction("projects")}
                            disabled={!!deletingAction}
                            className={`h-9 w-full shrink-0 gap-1.5 sm:w-auto ${accountGlassDangerOutlineButtonClassName}`}
                        >
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Delete
                        </Button>
                    </div>
                </div>
            </section>
            <ConfirmPopup
                open={!!pendingDeleteAction}
                title={pendingDeleteCopy?.title}
                message={pendingDeleteCopy?.message}
                confirmLabel="Delete"
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
