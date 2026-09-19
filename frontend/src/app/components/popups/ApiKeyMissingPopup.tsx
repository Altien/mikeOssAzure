"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { WarningPopup } from "../popups/WarningPopup";

interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
    /** Optional override for the body sentence. */
    message?: string;
    /** Optional override for the heading — e.g. a rejected key, not a missing one. */
    title?: string;
}

export function ApiKeyMissingPopup({
    open,
    onClose,
    provider,
    message,
    title,
}: Props) {
    const router = useRouter();
    if (!open) return null;

    // Upstream divergence (OSS-6, §2.3 items 3/5 — org Key Vault keys):
    // users cannot add personal keys in dev, so the popup points at the
    // organisation setup (/install) instead of account settings.
    const providerName = provider ? providerLabel(provider) : "this provider";
    const body =
        message ??
        `${providerName} is not configured for this organisation. ` +
            "Ask an administrator to open /install and configure the organisation credential.";

    const handleGoToSettings = () => {
        onClose();
        router.push("/install");
    };

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={title ?? "API key required"}
            message={body}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: "Open organisation setup",
                onClick: handleGoToSettings,
            }}
        />
    );
}
