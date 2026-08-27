import { completeText } from "./index";
import { getCommitteeModel } from "./registry";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

type CommitteeMemberConfig =
  | string
  | {
      id?: string;
      model: string;
      label?: string;
      systemPrompt?: string;
    };

export function isCommitteeId(model: string): boolean {
  return getCommitteeModel(model) !== null;
}

export async function completeCommitteeText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
  committeeStack?: string[];
  requestTimeoutMs?: number;
}): Promise<string> {
  const committee = getCommitteeModel(params.model);
  if (!committee) throw new Error(`Unknown committee model: ${params.model}`);
  if (committee.chair === params.model) {
    throw new Error(
      `Committee ${params.model} cannot use itself as the chair model.`,
    );
  }
  const stack = params.committeeStack ?? [];
  if (stack.includes(params.model)) {
    throw new Error(
      `Circular committee reference detected: ${[...stack, params.model].join(" -> ")}.`,
    );
  }
  const nextStack = [...stack, params.model];

  const members = committee.members.map(resolveCommitteeMember);
  const selfReferencingMember = members.find(
    (member) => member.model === params.model,
  );
  if (selfReferencingMember) {
    throw new Error(
      `Committee ${params.model} cannot include itself as member ${selfReferencingMember.label}.`,
    );
  }

  const memberResponses: { member: string; text: string }[] = [];
  for (const resolved of members) {
    memberResponses.push({
      member: resolved.label,
      text: await completeText({
        model: resolved.model,
        systemPrompt: [params.systemPrompt, resolved.systemPrompt]
          .filter(Boolean)
          .join("\n\n"),
        user: params.user,
        maxTokens: params.maxTokens,
        apiKeys: params.apiKeys,
        committeeStack: nextStack,
        requestTimeoutMs: params.requestTimeoutMs,
      }),
    });
  }

  return completeText({
    model: committee.chair,
    systemPrompt:
      "You are chairing a legal AI model committee. Synthesize the member analyses into one accurate, concise answer. Resolve disagreements explicitly when they affect the answer. Do not invent citations or facts that are not present in the member analyses.",
    user: [
      params.systemPrompt ? `Original system instruction:\n${params.systemPrompt}` : "",
      `Original user request:\n${params.user}`,
      "Committee member analyses:",
      ...memberResponses.map(
        (response) => `--- ${response.member} ---\n${response.text}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n"),
    maxTokens: params.maxTokens,
    apiKeys: params.apiKeys,
    committeeStack: nextStack,
    requestTimeoutMs: params.requestTimeoutMs,
  });
}

function resolveCommitteeMember(member: CommitteeMemberConfig) {
  if (typeof member === "string") {
    return { model: member, label: member, systemPrompt: "" };
  }
  return {
    model: member.model,
    label: member.label || member.id || member.model,
    systemPrompt: member.systemPrompt || "",
  };
}

export async function streamCommitteeChat(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  // Committee mode has no tool-calling loop. When the caller passes tools
  // (the main chat path always does), drop them and make clear in the system
  // prompt that the committee must answer directly.
  const toolNotice = params.tools?.length
    ? "Note: document and case-law tools are not available in committee mode. Answer directly from the conversation context; do not claim to have created, edited, or looked up documents."
    : "";
  const systemPrompt = [params.systemPrompt, toolNotice]
    .filter(Boolean)
    .join("\n\n");

  const latestUser = [...params.messages]
    .reverse()
    .find((message) => message.role === "user");
  const conversation = params.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const fullText = await completeCommitteeText({
    model: params.model,
    systemPrompt,
    user: latestUser ? conversation : conversation || "",
    maxTokens: 4096,
    apiKeys: params.apiKeys,
    requestTimeoutMs: params.requestTimeoutMs,
  });
  params.callbacks?.onContentDelta?.(fullText);
  return { fullText };
}
