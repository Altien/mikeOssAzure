"use client";

import { useEffect, useState } from "react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  listAllPlaybookRuns,
  type PlaybookRunListItem,
} from "@/app/lib/mikeApi";
import { describeError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { formatDateTime, runOutcome, runTitle } from "./PlaybookRuns";

const DOCUMENT_COLUMN = "flex w-72 shrink-0 items-center gap-2 pl-3 pr-4";
const PLAYBOOK_COLUMN = "w-56 shrink-0 truncate pr-4";
const OUTCOME_COLUMN = "w-44 shrink-0 truncate pr-4";
const MODE_COLUMN = "w-28 shrink-0 pr-4";
const DATE_COLUMN = "min-w-40 flex-1 pr-4";
const TABLE_MIN_WIDTH = "min-w-[50rem]";

/**
 * The caller's runs across every playbook in the workspace, newest first.
 * Opening a run takes the caller to it on its playbook's Runs tab.
 */
export function PlaybookRunsTable({
  workspaceId,
  search,
  disabled,
  onOpen,
}: {
  workspaceId: string | null;
  search: string;
  disabled: boolean;
  onOpen: (run: PlaybookRunListItem) => void;
}) {
  const [runs, setRuns] = useState<PlaybookRunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    listAllPlaybookRuns(workspaceId).then(
      (items) => {
        if (!current) return;
        setRuns(items);
        setError(null);
      },
      (err) => {
        if (!current) return;
        setError(describeError(err, { action: "load the runs" }).message);
        setRuns([]);
      },
    );
    return () => {
      current = false;
    };
  }, [workspaceId, attempt]);

  const query = search.trim().toLowerCase();
  const displayed = (runs ?? []).filter((run) =>
    `${runTitle(run)} ${run.playbookName}`.toLowerCase().includes(query),
  );

  return (
    <TableScrollArea>
      <div
        role="table"
        aria-label="Playbook runs"
        aria-busy={runs === null}
        className="flex min-h-full min-w-0 flex-col"
      >
        <div
          role="rowgroup"
          className={`table-sticky-header sticky top-0 z-[70] ${TABLE_MIN_WIDTH}`}
        >
          <TableHeaderRow role="row" className="min-w-0">
            <TableHeaderCell role="columnheader" className={DOCUMENT_COLUMN}>
              Document
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={PLAYBOOK_COLUMN}>
              Playbook
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={OUTCOME_COLUMN}>
              Outcome
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={MODE_COLUMN}>
              Mode
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={DATE_COLUMN}>
              Run
            </TableHeaderCell>
          </TableHeaderRow>
        </div>
        {runs === null ? (
          <TableBody role="rowgroup" className={TABLE_MIN_WIDTH}>
            {Array.from({ length: 6 }, (_, index) => (
              <TableRow
                key={index}
                role="row"
                className="min-w-0"
                interactive={false}
              >
                <TableCell role="cell" className={DOCUMENT_COLUMN}>
                  <SkeletonLine className="w-44" />
                </TableCell>
                <TableCell role="cell" className={PLAYBOOK_COLUMN}>
                  <SkeletonLine className="w-32" />
                </TableCell>
                <TableCell role="cell" className={OUTCOME_COLUMN}>
                  <SkeletonLine className="w-24" />
                </TableCell>
                <TableCell role="cell" className={MODE_COLUMN}>
                  <SkeletonLine className="w-12" />
                </TableCell>
                <TableCell role="cell" className={DATE_COLUMN}>
                  <SkeletonLine className="w-28" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        ) : error ? (
          <TableEmptyState>
            <EmptyState
              tone="error"
              title="Couldn’t load runs"
              description={error}
              action={
                <PillButtonUI
                  tone="white"
                  onClick={() => {
                    setRuns(null);
                    setError(null);
                    setAttempt((count) => count + 1);
                  }}
                >
                  Try again
                </PillButtonUI>
              }
            />
          </TableEmptyState>
        ) : displayed.length === 0 ? (
          <TableEmptyState>
            <EmptyState
              title={query ? "No matching runs" : "No runs yet"}
              description={
                query
                  ? "Try another document or playbook name."
                  : "Reviews you run with a playbook appear here."
              }
            />
          </TableEmptyState>
        ) : (
          <TableBody role="rowgroup" className={TABLE_MIN_WIDTH}>
            {displayed.map((run) => (
              <TableRow
                key={run.id}
                role="row"
                className="min-w-0"
                interactive={!disabled}
                onClick={() => {
                  if (!disabled) onOpen(run);
                }}
              >
                <TableCell role="cell" className={DOCUMENT_COLUMN}>
                  <FileTypeIcon
                    fileType={run.documentName ?? ""}
                    className="h-3.5 w-3.5"
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(run);
                    }}
                    title={runTitle(run)}
                    className="min-w-0 truncate rounded text-left text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                  >
                    {runTitle(run)}
                  </button>
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${PLAYBOOK_COLUMN} text-xs text-gray-600`}
                  title={run.playbookName}
                >
                  {run.playbookName || "Untitled playbook"}
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${OUTCOME_COLUMN} text-xs text-gray-600`}
                >
                  {runOutcome(run)}
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${MODE_COLUMN} text-xs text-gray-600`}
                >
                  {run.reviewMode === "permissive" ? "Permissive" : "Strict"}
                </TableCell>
                <TableCell role="cell" className={DATE_COLUMN}>
                  <time dateTime={run.startedAt}>
                    {formatDateTime(run.startedAt)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        )}
      </div>
    </TableScrollArea>
  );
}
