"use client";

import { useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { FieldLabel } from "@/app/components/ui/form-field";
import { createSupportReport } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

// Mirrors the backend's support_reports description limit.
const MAX_DESCRIPTION_LENGTH = 4000;

export function reportIssueConsentText(hasProject: boolean): string {
    // The grant covers attached documents too, so the wording must say so.
    const documents = hasProject ? ", and the documents in this project," : ", and the documents attached to it,";
    return `I allow the support team to inspect this conversation${documents} to investigate this issue. Everything is kept strictly confidential under the terms of our agreement.`;
}

interface ReportIssueModalProps {
    open: boolean;
    chatId: string;
    messageId: string;
    hasProject: boolean;
    onClose: () => void;
}

export function ReportIssueModal(props: ReportIssueModalProps) {
    // Mount the form only while open so each report starts blank.
    return props.open ? <ReportIssueForm {...props} /> : null;
}

function ReportIssueForm({
    open,
    chatId,
    messageId,
    hasProject,
    onClose,
}: ReportIssueModalProps) {
    const [description, setDescription] = useState("");
    const [allowAccess, setAllowAccess] = useState(false);
    const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
    const [error, setError] = useState<string | null>(null);
    const formId = "report-issue-form";
    const trimmed = description.trim();
    const consentText = reportIssueConsentText(hasProject);
    const sending = status === "sending";

    const submit = async () => {
        if (!trimmed || status !== "idle") return;
        setStatus("sending");
        setError(null);
        try {
            await createSupportReport({
                chat_id: chatId,
                message_id: messageId,
                description: trimmed,
                allow_conversation: allowAccess,
                allow_documents: allowAccess,
                consent_text: consentText,
            });
            setStatus("sent");
        } catch (err) {
            setError(userFacingApiError(err, "Your report could not be sent. Please try again."));
            setStatus("idle");
        }
    };

    if (status === "sent") {
        return (
            <Modal
                open={open}
                onClose={onClose}
                size="sm"
                className="h-auto"
                breadcrumbs={["Report issue"]}
                primaryAction={{ label: "Done", onClick: onClose }}
            >
                <p role="status" className="text-sm text-gray-700">
                    Thank you. Your report has been sent to the support team.
                </p>
            </Modal>
        );
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="sm"
            className="h-auto"
            breadcrumbs={["Report issue"]}
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: sending }}
            primaryAction={{
                label: sending ? "Sending..." : "Send report",
                type: "submit",
                form: formId,
                disabled: !trimmed || sending,
            }}
        >
            <form
                id={formId}
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <div>
                    <FieldLabel htmlFor="report-issue-description">
                        What went wrong?
                    </FieldLabel>
                    <ModalTextarea
                        id="report-issue-description"
                        autoFocus
                        required
                        maxLength={MAX_DESCRIPTION_LENGTH}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </div>
                <div>
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                        <input
                            type="checkbox"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-black"
                            checked={allowAccess}
                            onChange={(event) => setAllowAccess(event.target.checked)}
                        />
                        <span>{consentText}</span>
                    </label>
                    <p className="mt-2 pl-5.5 text-xs text-gray-500">
                        Access ends automatically after 14 days and covers the
                        conversation only up to this response.
                    </p>
                </div>
                {error && (
                    <p role="alert" className="text-sm text-red-600">
                        {error}
                    </p>
                )}
            </form>
        </Modal>
    );
}
