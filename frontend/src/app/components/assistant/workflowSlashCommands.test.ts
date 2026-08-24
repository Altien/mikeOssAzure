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
        name: "ignored-machine-name",
        title: "Contract Intake",
    },
} as Workflow;

describe("workflow slash commands", () => {
    it("derives the command from the workflow title", () => {
        expect(workflowSlashCommand(workflow)).toBe("/contract-intake");
    });

    it("strips punctuation and replaces whitespace with hyphens", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "  Contract & Intake   2026!  ",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe(
            "/contract-intake-2026",
        );
    });

    it("preserves and normalizes hyphens in the workflow title", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "Pre-Merger - Review",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe(
            "/pre-merger-review",
        );
    });

    it("supports alphabetical and numeric characters outside ASCII", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "Révision 合同 2",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe("/révision-合同-2");
    });

    it("does not create a command when the title has no letters or numbers", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: { ...workflow.metadata, title: " --- !!! " },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBeNull();
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
