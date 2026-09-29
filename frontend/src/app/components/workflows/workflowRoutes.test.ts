import { describe, it, expect } from "vitest";
import type { Workflow } from "../shared/types";
import { workflowDetailPath } from "./workflowRoutes";

// OSS-6: workflows are metadata-shaped (upstream 204d2d53) — the type moved
// from `workflow.type` to `workflow.metadata.type`.
function wf(id: string, type: Workflow["metadata"]["type"]) {
    return {
        id,
        metadata: { type } as Workflow["metadata"],
    };
}

describe("workflowDetailPath", () => {
    it("routes assistant workflows to /workflows/assistant/:id", () => {
        expect(workflowDetailPath(wf("w1", "assistant"))).toBe(
            "/workflows/assistant/w1",
        );
    });

    it("routes tabular workflows to /workflows/tabular-review/:id", () => {
        expect(workflowDetailPath(wf("w2", "tabular"))).toBe(
            "/workflows/tabular-review/w2",
        );
    });
});
