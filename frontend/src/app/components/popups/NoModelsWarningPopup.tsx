"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import type { NoModelsReason } from "../assistant/ModelToggle";
import { WarningPopup } from "./WarningPopup";

export function NoModelsWarningPopup({
    reason,
    onClose,
}: {
    reason: NoModelsReason | null;
    onClose: () => void;
}) {
    if (!reason) return null;

    return <VisibleNoModelsWarning reason={reason} onClose={onClose} />;
}

function VisibleNoModelsWarning({
    reason,
    onClose,
}: {
    reason: NoModelsReason;
    onClose: () => void;
}) {
    const router = useRouter();

    const routerModelsMissing = reason === "router-models";
    return (
        <WarningPopup
            open
            onClose={onClose}
            title="No models available"
            message={
                routerModelsMissing
                    ? "Your router is connected, but it has no saved models. Add at least one under Bring Your Own Keys → Routers."
                    : "Add an API key in Bring Your Own Keys before selecting a model."
            }
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: "Open Bring Your Own Keys",
                onClick: () => {
                    onClose();
                    router.push(
                        routerModelsMissing
                            ? "/settings/byok#routers"
                            : "/settings/byok",
                    );
                },
            }}
        />
    );
}
