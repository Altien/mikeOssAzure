"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { WarningPopup } from "./WarningPopup";

interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
    /** Optional override for the body sentence. */
    message?: string;
}

export function ApiKeyMissingModal({ open, onClose, provider, message }: Props) {
    const router = useRouter();
    if (!open) return null;

    const providerName = provider ? providerLabel(provider) : "this provider";
    const body =
        message ??
        `${providerName} is not configured for this organisation. ` +
            "Ask an administrator to open /install and configure the organisation credential.";

    const handleOpenOrganisationSetup = () => {
        onClose();
        router.push("/install");
    };

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title="API key required"
            message={body}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: "Open organisation setup",
                onClick: handleOpenOrganisationSetup,
            }}
        />
    );
}
