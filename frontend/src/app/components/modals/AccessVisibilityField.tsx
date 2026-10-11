"use client";

import { useId } from "react";
import type { ContentVisibility } from "@/app/components/shared/types";
import { FieldLabel } from "@/app/components/ui/form-field";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";

const OPTIONS: { value: ContentVisibility; label: string }[] = [
    { value: "private", label: "Private" },
    { value: "organization", label: "Public" },
];

/**
 * The "Access" choice for an organization's project or workflow, as it
 * appears among the item's details.
 *
 *   Private  only the individuals it is shared with can open it (the default)
 *   Public   every member of the organization can open and edit it
 *
 * It is not offered for a personal item, which has no "everyone" to be opened
 * to and is always shared by naming people.
 */
export function AccessVisibilityField({
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
    const labelId = useId();
    const descriptionId = useId();
    const organizationLabel = organizationName || "the organisation";

    return (
        <div
            data-slot="access-visibility-field"
            role="group"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
        >
            <FieldLabel as="p" id={labelId}>
                Access
            </FieldLabel>
            <ModalSegmentedToggle
                value={visibility}
                onChange={onChange}
                options={OPTIONS}
                disabled={disabled}
            />
            <p
                id={descriptionId}
                className="mt-1.5 text-xs leading-4 text-gray-500"
            >
                {visibility === "organization"
                    ? `Everyone in ${organizationLabel} can open and edit this ${resourceNoun}.`
                    : `Only the people you share this ${resourceNoun} with can open it.`}
            </p>
        </div>
    );
}
