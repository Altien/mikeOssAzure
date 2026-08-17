import React, { type ReactNode } from "react";
import { ModalUI } from "@mike/modal-ui";
import { cn } from "../../../shared/lib/utils";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  parentLabel?: string;
  children: ReactNode;
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    icon?: ReactNode;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    icon?: ReactNode;
  };
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  parentLabel = "Assistant",
  children,
  primaryAction,
  secondaryAction,
  className,
}: ModalProps): React.ReactElement | null {
  return (
    <ModalUI
      open={open}
      onClose={onClose}
      breadcrumbs={[parentLabel, title]}
      ariaLabel={title}
      size="md"
      className={cn("h-[min(600px,calc(100vh-2rem))]", className)}
      secondaryAction={
        secondaryAction ? (
          <PillButton
            tone="blue"
            size="normal"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </PillButton>
        ) : undefined
      }
      primaryAction={
        primaryAction ? (
          <PillButton
            tone="black"
            size="normal"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
          >
            {primaryAction.icon}
            {primaryAction.label}
          </PillButton>
        ) : undefined
      }
    >
      <div className="flex min-h-0 flex-1 flex-col [&_.overflow-y-auto]:-mx-2 [&_.overflow-y-auto]:px-2">
        {children}
      </div>
    </ModalUI>
  );
}
