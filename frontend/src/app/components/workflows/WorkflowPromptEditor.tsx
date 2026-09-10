"use client";

import {
  MarkdownEditor,
  type MarkdownEditorProps,
} from "@/app/components/ui/markdown-editor";
export function WorkflowPromptEditor({
  className,
  ...props
}: MarkdownEditorProps) {
  return (
    <MarkdownEditor
      {...props}
      ariaLabel={props.ariaLabel ?? "Workflow prompt"}
      className={className}
    />
  );
}
