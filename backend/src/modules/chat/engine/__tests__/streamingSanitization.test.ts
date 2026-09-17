import { describe, expect, it } from "vitest";
import {
    ASSISTANT_ERROR_MESSAGE,
    sanitizeAssistantSseChunk,
} from "../streaming";

describe("assistant SSE error boundary", () => {
    it("replaces provider and tool errors before writing to the client", () => {
        const provider = sanitizeAssistantSseChunk(
            'data: {"type":"error","message":"private api key sk-secret-value"}\n\n',
        );
        const tool = sanitizeAssistantSseChunk(
            'data: {"type":"tool_result","error":"private database relation"}\n\n',
        );
        expect(provider).toContain(ASSISTANT_ERROR_MESSAGE);
        expect(provider).not.toContain("sk-secret-value");
        expect(tool).toContain("This tool could not complete its request.");
        expect(tool).not.toContain("private database relation");
    });

    it("keeps explicitly safe guidance and stream terminators", () => {
        const guidance = 'data: {"type":"error","message":"Choose a document","safe_to_display":true}\n\n';
        expect(sanitizeAssistantSseChunk(guidance)).toContain("Choose a document");
        expect(sanitizeAssistantSseChunk("data: [DONE]\n\n")).toBe("data: [DONE]\n\n");
    });
});
