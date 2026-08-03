import { describe, expect, it } from "vitest";
import type { Workflow } from "../shared/types";
import {
    exactSlashWorkflow,
    matchingSlashWorkflows,
    slashCommandQuery,
    workflowSlashCommand,
} from "./workflowSlashCommands";

const workflow = {
    id: "workflow-1",
    metadata: {
        name: "contract-intake",
        title: "Contract Intake",
    },
} as Workflow;

describe("workflow slash commands", () => {
    it("derives the command from the workflow name", () => {
        expect(workflowSlashCommand(workflow)).toBe("/contract-intake");
    });

    it("recognizes a slash command without arguments", () => {
        expect(slashCommandQuery("/contract")).toBe("/contract");
        expect(slashCommandQuery("/contract run this")).toBeNull();
    });

    it("matches workflows by trigger prefix", () => {
        expect(matchingSlashWorkflows([workflow], "/cont")).toEqual([workflow]);
        expect(matchingSlashWorkflows([workflow], "/other")).toEqual([]);
    });

    it("resolves an exact trigger", () => {
        expect(exactSlashWorkflow([workflow], "/CONTRACT-INTAKE")).toBe(
            workflow,
        );
    });
});
