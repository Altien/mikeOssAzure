import { describe, it, expect } from "vitest";
import { workflowDetailPath } from "./workflowRoutes";

describe("workflowDetailPath", () => {
    it("routes assistant workflows to /workflows/assistant/:id", () => {
        expect(workflowDetailPath({ id: "w1", type: "assistant" })).toBe(
            "/workflows/assistant/w1",
        );
    });

    it("routes everything else to /workflows/tabular-review/:id", () => {
        expect(
            workflowDetailPath({ id: "w2", type: "tabular-review" as never }),
        ).toBe("/workflows/tabular-review/w2");
    });
});
