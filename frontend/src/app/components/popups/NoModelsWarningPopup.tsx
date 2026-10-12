"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
    NO_MODELS_MESSAGES,
    isOrganizationNoModelsReason,
    type NoModelsReason,
} from "@/shared/lib/modelCatalog";
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
    const { activeOrganization } = useWorkspace();
    // When the fix is the organization's to make, the button goes to where
    // its providers are set up — an admin can act there, and a member sees
    // what is and is not in place. Otherwise it is the caller's own keys.
    const organizationId =
        isOrganizationNoModelsReason(reason) && activeOrganization
            ? activeOrganization.id
            : null;

    return (
        <WarningPopup
            open
            onClose={onClose}
            title="No models available"
            message={NO_MODELS_MESSAGES[reason]}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={
                organizationId
                    ? {
                          label: "Open Model Providers",
                          onClick: () => {
                              onClose();
                              router.push(
                                  `/organizations/${organizationId}?tab=providers`,
                              );
                          },
                      }
                    : {
                          label: "Open Bring Your Own Keys",
                          onClick: () => {
                              onClose();
                              router.push("/settings/byok");
                          },
                      }
            }
        />
    );
}
