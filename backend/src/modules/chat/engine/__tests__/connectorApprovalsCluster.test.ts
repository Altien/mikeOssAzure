// Dev divergence (sync-log: 2ec7cfc1): with the multi-replica stream-run
// cluster active, an approved connector action's outcome must still be
// appended to the paused assistant message. That append happens before any
// continuation run exists, so the run-fenced path would refuse it.
import { describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalItem } from "@mike/contracts";

const mocks = vi.hoisted(() => ({ mcp: vi.fn() }));
vi.mock("../../../../lib/streamRunCluster", async (original) => ({
  ...(await original<typeof import("../../../../lib/streamRunCluster")>()),
  streamRunCluster: () => ({}) as never,
}));
vi.mock("../../../../lib/mcpConnectors", async (original) => ({
  ...(await original<typeof import("../../../../lib/mcpConnectors")>()),
  executeApprovedMcpToolCall: mocks.mcp,
}));

import { runApprovedConnectorActions } from "../tools/connectorApprovals";

const item: ConnectorApprovalItem = {
  id: "approve-slack",
  kind: "approval",
  connector_name: "Slack",
  tool_name: "mcp_slack_post",
  title: "Post message",
  arguments: { channel: "general", text: "hi" },
  binding: { type: "mcp", connector_id: "c1", tool_id: "t1" },
};

describe("approved connector outcomes in cluster mode", () => {
  it("appends the outcome unfenced after the single-use response claim", async () => {
    const row = {
      id: "assistant-1",
      content: [
        { type: "ask_inputs", event_id: "ask-1", items: [item] },
        {
          type: "ask_inputs_response",
          ask_event_id: "ask-1",
          responses: [{ id: item.id, kind: "approval", decision: "approve" }],
        },
      ],
      author_user_id: "user-1",
    };
    const rpcCalls: string[] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
    };
    const db = {
      from: () => builder,
      rpc: async (name: string) => {
        rpcCalls.push(name);
        return { data: "appended", error: null };
      },
    };
    mocks.mcp.mockResolvedValue({
      content: '{"ok":true}',
      event: {
        type: "mcp_tool_call",
        connector_id: "c1",
        connector_name: "Slack",
        tool_name: "post",
        openai_tool_name: item.tool_name,
        status: "ok",
      },
    });
    const events = await runApprovedConnectorActions({
      db: db as never,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });
    expect(events).toHaveLength(1);
    expect(mocks.mcp).toHaveBeenCalledOnce();
    expect(rpcCalls).toEqual(["append_chat_assistant_events"]);
  });
});
