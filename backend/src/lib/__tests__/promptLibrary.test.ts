import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createPromptLibraryItem,
    deletePromptLibraryItem,
    getPromptLibraryItem,
    listBuiltInPrompts,
    listPromptLibrary,
    updatePromptLibraryItem,
} from "../promptLibrary";
import { createServerSQLite } from "../sqlite";

const createdPromptIds: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    const db = createServerSQLite();
    for (const id of createdPromptIds.splice(0)) {
        await db.from("saved_prompts").delete().eq("id", id);
    }
});

describe("built-in prompt library", () => {
    it("does not require the private prompt data file", async () => {
        vi.stubEnv(
            "MIKE_BUILTIN_PROMPTS_PATH",
            path.join(os.tmpdir(), `missing-prompts-${crypto.randomUUID()}.json`),
        );
        vi.resetModules();
        const library = await import("../promptLibrary");
        expect(library.listBuiltInPrompts()).toEqual([]);
    });

    it("loads optional runtime data and protects built-in prompts", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-prompts-"));
        const promptPath = path.join(tempDir, "prompts.json");
        fs.writeFileSync(
            promptPath,
            JSON.stringify([
                {
                    id: "private-example-1",
                    name: "Example analysis",
                    prompt: "Analyze the supplied material.",
                    promptType: "Assist",
                    categories: ["Analyze"],
                    practiceAreas: ["Commercial"],
                    sourceRequirements: ["Files"],
                    originalCreator: null,
                    originalCreatedAt: null,
                },
            ]),
        );
        try {
            vi.stubEnv("MIKE_BUILTIN_PROMPTS_PATH", promptPath);
            vi.resetModules();
            const library = await import("../promptLibrary");
            const [prompt] = library.listBuiltInPrompts();
            expect(prompt).toMatchObject({
                id: "private-example-1",
                source: "built_in",
                categories: ["Analyze"],
            });
            prompt.categories.push("Changed");
            expect(library.listBuiltInPrompts()[0].categories).not.toContain(
                "Changed",
            );
            await expect(
                library.deletePromptLibraryItem("u1", prompt.id),
            ).rejects.toThrow(/cannot be deleted/i);
            await expect(
                library.updatePromptLibraryItem("u1", prompt.id, {
                    name: "Changed",
                    prompt: "Changed",
                }),
            ).rejects.toThrow(/cannot be edited/i);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe("saved prompt persistence", () => {
    it("creates, lists, reads, updates, and deletes a user prompt", async () => {
        const userId = crypto.randomUUID();
        const created = await createPromptLibraryItem(userId, {
            name: "Review indemnity",
            prompt: "Review the attached agreement's indemnity provisions.",
            description: "Contract review starting point",
            promptType: "Assist",
            categories: ["Analyze", "Analyze"],
            practiceAreas: ["Commercial Transactions"],
            sourceRequirements: ["Files"],
        });
        createdPromptIds.push(created.id);

        const builtInCount = listBuiltInPrompts().length;
        expect(created).toMatchObject({
            userId,
            source: "user",
            categories: ["Analyze"],
            sourceRequirements: ["Files"],
        });
        const listed = await listPromptLibrary(userId);
        expect(listed[0]).toMatchObject({ id: created.id, name: "Review indemnity" });
        expect(listed).toHaveLength(builtInCount + 1);
        await expect(getPromptLibraryItem(userId, created.id)).resolves.toMatchObject({ id: created.id });

        const updated = await updatePromptLibraryItem(userId, created.id, {
            name: "Review liability and indemnity",
            prompt: "Review liability, indemnity, and insurance provisions.",
            categories: ["Analyze", "Compare"],
        });
        expect(updated).toMatchObject({
            name: "Review liability and indemnity",
            categories: ["Analyze", "Compare"],
        });

        await deletePromptLibraryItem(userId, created.id);
        createdPromptIds.splice(createdPromptIds.indexOf(created.id), 1);
        await expect(getPromptLibraryItem(userId, created.id)).rejects.toThrow(/not found/i);
    });

    it("does not expose another user's custom prompt", async () => {
        const created = await createPromptLibraryItem("owner", { name: "Private prompt", prompt: "Private instructions" });
        createdPromptIds.push(created.id);
        await expect(getPromptLibraryItem("other", created.id)).rejects.toThrow(/not found/i);
        expect((await listPromptLibrary("other")).some((item) => item.id === created.id)).toBe(false);
    });

    it("validates required text and bounded metadata", async () => {
        await expect(createPromptLibraryItem("u1", { name: "", prompt: "Prompt" })).rejects.toThrow(/name is required/i);
        await expect(createPromptLibraryItem("u1", { name: "Name", prompt: "" })).rejects.toThrow(/prompt is required/i);
        await expect(createPromptLibraryItem("u1", {
            name: "Name",
            prompt: "Prompt",
            categories: Array.from({ length: 21 }, (_, index) => `Category ${index}`),
        })).rejects.toThrow(/at most 20/i);
    });
});
