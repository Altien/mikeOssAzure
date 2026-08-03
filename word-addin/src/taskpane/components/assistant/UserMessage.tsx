import React from "react";

/**
 * Right-aligned user bubble, duplicated from the web app's UserMessage
 * (minus the file/workflow chips the pane doesn't attach).
 */
export function UserMessage({ content }: { content: string }): React.ReactElement {
  return (
    <div className="w-full flex justify-end">
      <div className="max-w-[80%] bg-gray-100 rounded-xl px-4 py-3">
        <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">
          {content}
        </p>
      </div>
    </div>
  );
}
