"use client";

import { useId } from "react";
import type { ContentVisibility } from "@/app/components/shared/types";
import { FieldLabel } from "@/app/components/ui/form-field";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

/**
 * The public/private choice for an organization's project or workflow, as it
 * appears among the item's details.
 *
 *   Public   every member of the organization can open and edit it
 *   Private  only the individuals it is shared with can
 *
 * It is not offered for a personal item, which has no "everyone" to be opened
 * to and is always shared by naming people.
 */
export function PublicAccessToggle({
    visibility,
    onChange,
    organizationName,
    resourceNoun,
    disabled = false,
}: {
    visibility: ContentVisibility;
    onChange: (visibility: ContentVisibility) => void;
    organizationName?: string | null;
    resourceNoun: "project" | "workflow";
    disabled?: boolean;
}) {
    const descriptionId = useId();
    const isPublic = visibility === "organization";
    const organizationLabel = organizationName || "the organisation";

    return (
        <div data-slot="public-access-toggle">
            <FieldLabel as="p">Access</FieldLabel>
            <ToggleSwitchUI
                checked={isPublic}
                disabled={disabled}
                onCheckedChange={(checked) =>
                    onChange(checked ? "organization" : "private")
                }
                aria-label="Public"
                aria-describedby={descriptionId}
            >
                Public
            </ToggleSwitchUI>
            <p
                id={descriptionId}
                className="mt-1.5 text-xs leading-4 text-gray-500"
            >
                {isPublic
                    ? `Everyone in ${organizationLabel} can open and edit this ${resourceNoun}.`
                    : `Private. Only the people you share this ${resourceNoun} with can open it.`}
            </p>
        </div>
    );
}
