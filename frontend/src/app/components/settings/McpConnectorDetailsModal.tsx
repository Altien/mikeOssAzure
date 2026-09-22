"use client";

import { useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import { Modal } from "@/app/components/modals/Modal";
import {
  McpConnectorForm,
  type McpConnectorFormDraft,
} from "@/app/components/settings/McpConnectorForm";
import { findConnectorPreset } from "@/app/components/settings/connectorPresets";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

export function McpConnectorDetailsModal({
  connector,
  draft,
  busyKey,
  toolsLoading,
  clearTokenStatus,
  showToken,
  onDraftChange,
  onShowTokenChange,
  onClose,
  onClearBearerToken,
  onRefresh,
  reconnectingOAuth,
  onCancelReconnectOAuth,
  onDelete,
  onToolEnabled,
}: {
  connector: McpConnectorSummary | null;
  draft: McpConnectorFormDraft;
  busyKey: string | null;
  toolsLoading: boolean;
  clearTokenStatus: "idle" | "clearing" | "cleared";
  showToken: boolean;
  onDraftChange: (draft: McpConnectorFormDraft) => void;
  onShowTokenChange: (show: boolean) => void;
  onClose: () => void;
  onClearBearerToken: (connectorId: string) => Promise<void>;
  onRefresh: (connectorId: string) => Promise<void>;
  reconnectingOAuth: boolean;
  onCancelReconnectOAuth: () => void;
  onDelete: (connectorId: string) => Promise<void>;
  onToolEnabled: (
    connectorId: string,
    toolId: string,
    enabled: boolean,
  ) => Promise<void>;
}) {
  // A connector that matches a preset was installed from Discover: its URL and
  // auth are fixed, so there is nothing to edit and the modal is tools-only.
  const isCustom = !!connector && !findConnectorPreset(connector.serverUrl);
  // The picked section is stored against the connector it was picked for, so
  // opening a different connector falls back to "details" without an effect
  // resetting state after the first render.
  const [picked, setPicked] = useState<{
    connectorId: string | null;
    section: "details" | "tools";
  }>({ connectorId: null, section: "details" });
  const section =
    picked.connectorId === (connector?.id ?? null) ? picked.section : "details";
  const setSection = (next: "details" | "tools") =>
    setPicked({ connectorId: connector?.id ?? null, section: next });
  const showDetails = isCustom && section === "details";

  return (
    <Modal
      open={!!connector}
      onClose={onClose}
      breadcrumbs={["Connectors", connector?.name ?? "MCP connector"]}
      size="lg"
      secondaryAction={
        connector
          ? {
              label: "Delete",
              variant: "danger",
              onClick: () => void onDelete(connector.id),
              disabled: busyKey === `delete:${connector.id}`,
            }
          : undefined
      }
    >
      {connector && (
        <div className="flex min-h-0 flex-1 flex-col gap-5 pb-4">
          {isCustom && (
            <div className="flex items-center gap-1.5">
              {(["details", "tools"] as const).map((tab) => (
                <TabPillButtonUI
                  key={tab}
                  active={section === tab}
                  onClick={() => setSection(tab)}
                >
                  {tab === "details" ? "Details" : "Tools"}
                </TabPillButtonUI>
              ))}
            </div>
          )}
          {showDetails ? (
            <McpConnectorForm
              idPrefix="connector-config"
              draft={draft}
              showToken={showToken}
              tokenPlaceholder={
                connector.hasAuthConfig ? "Saved token encrypted" : "Bearer token"
              }
              tokenAction={
                connector.hasAuthConfig || clearTokenStatus === "cleared"
                  ? {
                      label: clearTokenStatus === "cleared" ? "Cleared" : "Clear",
                      loading: clearTokenStatus === "clearing",
                      cleared: clearTokenStatus === "cleared",
                      onClick: () => void onClearBearerToken(connector.id),
                    }
                  : undefined
              }
              onDraftChange={(next) =>
                onDraftChange({
                  ...draft,
                  name: next.name,
                  serverUrl: next.serverUrl,
                  bearerToken: next.bearerToken,
                  customHeaders: next.customHeaders,
                })
              }
              onShowTokenChange={onShowTokenChange}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-baseline justify-between gap-2">
                <FieldLabel as="p">
                  {toolsLoading ? connector.toolCount : connector.tools.length}{" "}
                  {(toolsLoading
                    ? connector.toolCount
                    : connector.tools.length) === 1
                    ? "Tool"
                    : "Tools"}
                </FieldLabel>
                <div className="mb-2 flex items-center gap-3">
                  {reconnectingOAuth && (
                    <button
                      type="button"
                      onClick={onCancelReconnectOAuth}
                      className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onRefresh(connector.id)}
                    disabled={busyKey === `refresh:${connector.id}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    {busyKey === `refresh:${connector.id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                  </button>
                </div>
              </div>
              {toolsLoading ? (
                <ToolListSkeleton count={connector.toolCount} fill />
              ) : (
                <ScrollableToolList
                  connector={connector}
                  busyKey={busyKey}
                  onToolEnabled={onToolEnabled}
                  fill
                />
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ToolListSkeleton({
  count,
  fill = false,
}: {
  count: number;
  fill?: boolean;
}) {
  const rowCount = Math.min(Math.max(count || 3, 3), 8);
  return (
    <div
      className={`overflow-hidden rounded-lg border border-gray-100 bg-white/60 ${
        fill ? "min-h-0 flex-1" : "max-h-72"
      }`}
    >
      <div>
        {Array.from({ length: rowCount }).map((_, index) => (
          <div key={index} className="px-3 py-3">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <div className="h-5 w-5" />
              <div className="h-3.5 w-full max-w-[220px] animate-pulse rounded bg-gray-100" />
              <div className="h-4 w-7 animate-pulse rounded-full bg-gray-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScrollableToolList({
  connector,
  busyKey,
  onToolEnabled,
  fill = false,
}: {
  connector: McpConnectorSummary;
  busyKey?: string | null;
  onToolEnabled?: (
    connectorId: string,
    toolId: string,
    enabled: boolean,
  ) => Promise<void>;
  fill?: boolean;
}) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

  if (connector.tools.length === 0) {
    return (
      <div
        className={`rounded-lg px-3 py-3 text-sm text-gray-500 ${LIQUID_GLASS_FLAT_CLASS} ${
          fill ? "min-h-0 flex-1" : ""
        }`}
      >
        No tools discovered yet.
      </div>
    );
  }

  return (
    <div
      className={`overflow-y-auto rounded-lg border border-gray-100 bg-white/60 ${
        fill ? "min-h-0 flex-1" : "max-h-72"
      }`}
    >
      <div>
        {connector.tools.map((tool) => {
          const disabled =
            !onToolEnabled ||
            busyKey === `tool:${tool.id}` ||
            tool.requiresConfirmation;
          const isExpanded = expandedToolId === tool.id;
          const toolLabel = tool.title || tool.toolName;
          return (
            <div key={tool.id} className="px-3 py-3">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedToolId(isExpanded ? null : tool.id)}
                  className="inline-flex h-5 w-5 items-center justify-center text-gray-400 transition-colors hover:text-gray-800"
                  aria-label={`${
                    isExpanded ? "Collapse" : "Expand"
                  } ${toolLabel}`}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      isExpanded ? "" : "-rotate-90"
                    }`}
                  />
                </button>
                <p className="min-w-0 truncate text-sm font-medium text-gray-700">
                  {toolLabel}
                </p>
                {onToolEnabled ? (
                  <ToggleSwitchUI
                    checked={tool.enabled}
                    disabled={disabled || busyKey === `tool:${tool.id}`}
                    aria-busy={busyKey === `tool:${tool.id}`}
                    aria-label={`${toolLabel} enabled`}
                    onCheckedChange={(enabled) =>
                      void onToolEnabled(connector.id, tool.id, enabled)
                    }
                  />
                ) : (
                  <span
                    className={`text-xs font-medium ${
                      tool.enabled ? "text-green-600" : "text-gray-500"
                    }`}
                  >
                    {tool.enabled ? "Enabled" : "Disabled"}
                  </span>
                )}
              </div>
              {isExpanded && (
                <div className="ml-7 mt-2 min-w-0">
                  {tool.requiresConfirmation && (
                    <p className="text-xs font-medium text-amber-700">
                      Confirmation required
                    </p>
                  )}
                  {tool.description && (
                    <p className="mt-1 text-xs text-gray-500">
                      {tool.description}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
