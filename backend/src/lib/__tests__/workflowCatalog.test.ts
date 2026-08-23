import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogKeyFromWorkflowId,
  catalogWorkflowId,
  catalogWorkflowToLegacy,
  ensureDefaultWorkflows,
  resetEnsuredDefaultUsersForTests,
  type WorkflowCatalogRow,
} from "../workflowCatalog";

const CATALOG_ROW: WorkflowCatalogRow = {
  id: "catalog-1",
  workflow_key: "proofread",
  distribution: "default",
  version: "1.0.0",
  title: "Proofread",
  description: "Proofread a document.",
  type: "assistant",
  prompt_md: "# Proofread\n\nCheck the document.",
  columns_config: null,
  contributors: [
    {
      name: "Mike",
      organisation: null,
      role: null,
      linkedin: null,
    },
  ],
  language: "English",
  practice: "General Transactions",
  jurisdictions: ["General"],
  pack_key: null,
  pack_title: null,
  pack_description: null,
  pack_version: null,
  source_commit: "a".repeat(40),
  content_hash: "b".repeat(64),
  active: true,
  created_at: "2026-08-23T00:00:00.000Z",
  updated_at: "2026-08-23T00:00:00.000Z",
};

describe("workflow catalog identifiers", () => {
  it("maps stable catalog keys to legacy builtin ids and back", () => {
    expect(catalogWorkflowId("proofread")).toBe("builtin-proofread");
    expect(catalogKeyFromWorkflowId("builtin-proofread")).toBe("proofread");
    expect(catalogKeyFromWorkflowId("proofread")).toBeNull();
    expect(catalogKeyFromWorkflowId("builtin-../proofread")).toBeNull();
  });

  it("preserves the compatibility response without embedding reference bytes", () => {
    expect(catalogWorkflowToLegacy(CATALOG_ROW)).toEqual(
      expect.objectContaining({
        id: "builtin-proofread",
        user_id: null,
        is_system: true,
        metadata: expect.objectContaining({
          name: "proofread",
          title: "Proofread",
          type: "assistant",
        }),
        skill_md: CATALOG_ROW.prompt_md,
        reference_files: [],
      }),
    );
  });
});

describe("ensureDefaultWorkflows request-path cost", () => {
  beforeEach(() => resetEnsuredDefaultUsersForTests());

  it("asks Postgres to install catalog defaults once per user per process", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 5, error: null });
    const db = { rpc } as never;

    await expect(ensureDefaultWorkflows("user-1", db)).resolves.toBe(5);
    await expect(ensureDefaultWorkflows("user-1", db)).resolves.toBe(0);
    await expect(ensureDefaultWorkflows("user-2", db)).resolves.toBe(5);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("install_missing_default_workflows", {
      p_user_id: "user-1",
    });
  });

  it("retries after a failed install instead of caching the failure", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: new Error("db down") })
      .mockResolvedValue({ data: 5, error: null });
    const db = { rpc } as never;

    await expect(ensureDefaultWorkflows("user-1", db)).rejects.toThrow(
      "db down",
    );
    await expect(ensureDefaultWorkflows("user-1", db)).resolves.toBe(5);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
