import { describe, expect, it } from "vitest";
import type { Workflow } from "../shared/types";
import {
    exactSlashWorkflow,
    matchingSlashWorkflows,
    slashCommandQuery,
} from "./workflowSlashCommands";

const workflow = {
    id: "workflow-1",
    metadata: {
        title: "Contract Intake",
        slash_trigger: "/contract-intake",
    },
} as Workflow;

describe("workflow slash commands", () => {
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
