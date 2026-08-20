import React, { useState } from "react";
import { Check, Eye, Pen } from "lucide-react";
import type { WordEditApplyMode } from "../../lib/wordChatSettings";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownTrigger,
} from "../primitives/Dropdown";

interface ApplyModeOption {
  mode: WordEditApplyMode;
  label: string;
  description: string;
  Icon: typeof Eye;
}

const REVIEW_OPTION: ApplyModeOption = {
  mode: "approval",
  label: "Review",
  description:
    "Review and propose tracked changes which are applied after approval",
  Icon: Eye,
};
const DIRECT_OPTION: ApplyModeOption = {
  mode: "direct",
  label: "Edit",
  description: "Directly edit the document in tracked changes",
  Icon: Pen,
};
const OPTIONS = [REVIEW_OPTION, DIRECT_OPTION];

/**
 * Composer control choosing how streamed edits reach the document: a compact
 * pill showing the active mode that opens a two-option menu (title +
 * consequence per option), in the style of the model picker beside it.
 */
export function EditApplyModeMenu({
  mode,
  onModeChange,
}: {
  mode: WordEditApplyMode;
  onModeChange: (mode: WordEditApplyMode) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = mode === "direct" ? DIRECT_OPTION : REVIEW_OPTION;

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label="Choose how edits are applied"
          title="Choose how edits are applied"
          data-testid="edit-apply-toggle"
          className={`ml-1 flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 ${
            open ? "text-gray-700" : ""
          }`}
        >
          <active.Icon className="h-3.5 w-3.5 shrink-0" />
          <span>{active.label}</span>
        </button>
      </DropdownTrigger>
      <DropdownContent side="top" align="start" sideOffset={8} className="w-72">
        <DropdownLabel className="normal-case text-xs tracking-normal">
          How should edits be applied?
        </DropdownLabel>
        {OPTIONS.map((option) => (
          <DropdownItem
            key={option.mode}
            onSelect={() => onModeChange(option.mode)}
            selected={option.mode === mode}
            className="items-start py-2"
          >
            <option.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500" />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-gray-800">
                {option.label}
              </span>
              <span className="text-xs text-gray-500">
                {option.description}
              </span>
            </span>
            {option.mode === mode && (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-600" />
            )}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
