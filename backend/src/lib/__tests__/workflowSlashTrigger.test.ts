import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowSlashTrigger,
  workflowSlashTriggerFromSkillMd,
} from "../workflowSlashTrigger";

describe("normalizeWorkflowSlashTrigger", () => {
  it("accepts lowercase slash triggers", () => {
    expect(normalizeWorkflowSlashTrigger(" /contract-intake ")).toBe(
      "/contract-intake",
    );
  });

  it("rejects invalid triggers", () => {
    expect(normalizeWorkflowSlashTrigger("contract-intake")).toBeNull();
    expect(normalizeWorkflowSlashTrigger("/Contract Intake")).toBeNull();
  });
});

describe("workflowSlashTriggerFromSkillMd", () => {
  it("reads mike-slash-trigger from metadata frontmatter", () => {
    expect(
      workflowSlashTriggerFromSkillMd(`---
name: contract-intake
metadata:
  mike-display-name: "Contract Intake"
  mike-slash-trigger: "/contract-intake"
---
# Contract Intake`),
    ).toBe("/contract-intake");
  });

  it("ignores a trigger outside the metadata mapping", () => {
    expect(
      workflowSlashTriggerFromSkillMd(`---
name: contract-intake
mike-slash-trigger: "/contract-intake"
metadata:
  mike-display-name: "Contract Intake"
---`),
    ).toBeNull();
  });
});
