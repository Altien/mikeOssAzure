"use client";

import { useEffect, useRef, useState } from "react";
import { CornerDownRight, Folder } from "lucide-react";
import type { Document, TabularReviewRow } from "../shared/types";
import { TABLE_CHECKBOX_CLASS } from "../shared/TablePrimitive";
import { TRExpandedCellSurface } from "./TRExpandedCellSurface";

// Dev adaptation of upstream 6ae1f98d: lucide icons instead of upstream's
// FileTypeIcon / FolderSvgIcon (deferred frontend refactor, KNOWLEDGE §5), and
// no scroll-close signal (dev's TRTable has none).

interface Props {
    row: TabularReviewRow;
    sourceDocuments: Document[];
    selected: boolean;
    className: string;
    onToggleSelection: () => void;
}

export function TRFirstColumnCell({
    row,
    sourceDocuments,
    selected,
    className,
    onToggleSelection,
}: Props) {
    const [expanded, setExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!expanded) return;
        function handleClickOutside(event: MouseEvent) {
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target as Node)
            ) {
                setExpanded(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [expanded]);

    return (
        <div ref={containerRef} className={`${className} relative`}>
            <input
                type="checkbox"
                checked={selected}
                onChange={onToggleSelection}
                className={TABLE_CHECKBOX_CLASS}
            />
            {row.row_type === "folder" ? (
                <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    className="flex min-w-0 flex-1 items-center text-left"
                    aria-expanded={expanded}
                >
                    <Folder className="mr-2 h-3.5 w-3.5 shrink-0 text-gray-500" />
                    <span className="line-clamp-1" title={row.label}>
                        {row.label}
                    </span>
                </button>
            ) : (
                <span className="line-clamp-1" title={row.label}>
                    {row.label}
                </span>
            )}

            {row.row_type === "folder" && expanded && (
                <TRExpandedCellSurface>
                    <div className="p-2 text-xs text-gray-800">
                        <div className="mb-1.5 flex items-center font-medium">
                            <Folder className="mr-2 h-3.5 w-3.5 shrink-0 text-gray-500" />
                            <span className="truncate" title={row.label}>
                                {row.label}
                            </span>
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                            {sourceDocuments.map((document) => (
                                <div
                                    key={document.id}
                                    className="flex min-h-7 items-center py-1"
                                >
                                    <CornerDownRight
                                        className="mr-2 h-3.5 w-3.5 shrink-0 text-gray-400"
                                        aria-hidden="true"
                                    />
                                    <span
                                        className="min-w-0 truncate"
                                        title={document.filename}
                                    >
                                        {document.filename}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </TRExpandedCellSurface>
            )}
        </div>
    );
}
