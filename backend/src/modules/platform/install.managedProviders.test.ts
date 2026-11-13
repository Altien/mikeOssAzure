import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig, setConfig } = vi.hoisted(() => ({ getConfig: vi.fn(), setConfig: vi.fn() }));

vi.mock("../../lib/config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/config")>()),
    getConfig,
    setConfig,
}));

vi.mock("../../lib/install/installAuth", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/install/installAuth")>()),
    loadInstallSession: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.installSession = { kind: "bootstrap" };
        next();
    },
}));

import { installRouter } from "./install.routes";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/install", installRouter);

const settings = new Map<string, string>();

function save(id: string, form: Record<string, string>) {
    return request(app).post(`/install/items/${id}`).type("form").send(form);
}

describe("/install administrator-entered provider rows", () => {
    beforeEach(() => {
        settings.clear();
        getConfig.mockReset().mockImplementation(async (name: string) => settings.get(name) ?? "");
        setConfig.mockReset().mockResolvedValue("id");
    });

    it("saves key, URL and model names to their Key Vault secrets", async () => {
        const res = await save("ai-tokenjuice-key", {
            "tokenjuice-api-key": "secret-value",
            "tokenjuice-base-url": "https://tj.example.test/v1",
            "tokenjuice-models": "juice-large, juice-small",
        });
        expect(res.status).toBe(303);
        expect(setConfig.mock.calls).toEqual([
            ["tokenjuice-api-key", "secret-value"],
            ["tokenjuice-base-url", "https://tj.example.test/v1"],
            ["tokenjuice-models", "juice-large, juice-small"],
        ]);
    });

    it.each([
        "ftp://tj.example.test/v1",
        "https://user:pass@tj.example.test/v1",
        "https://tj.example.test/v1?key=1",
        "https://tj.example.test/v1#top",
        "https://%zz/v1",
    ])("rejects the bad base URL %s and writes nothing", async (bad) => {
        const res = await save("ai-tokenjuice-key", {
            "tokenjuice-api-key": "secret-value",
            "tokenjuice-base-url": bad,
            "tokenjuice-models": "juice-large",
        });
        expect(res.status).toBe(400);
        expect(res.text).toContain("format check failed");
        expect(res.text).not.toContain("secret-value");
        expect(setConfig).not.toHaveBeenCalled();
    });

    it("rejects a model name that cannot be used and writes nothing", async () => {
        const res = await save("ai-meta-key", { "meta-api-key": "secret-value", "meta-models": "a?b" });
        expect(res.status).toBe(400);
        expect(setConfig).not.toHaveBeenCalled();
    });

    it("leaves Meta's base URL unset when it is left empty", async () => {
        const res = await save("ai-meta-key", {
            "meta-api-key": "secret-value",
            "meta-base-url": "",
            "meta-models": "muse-spark-1.1",
        });
        expect(res.status).toBe(303);
        expect(setConfig.mock.calls.map(([name]) => name)).toEqual(["meta-api-key", "meta-models"]);
    });

    it("lets an administrator change model names without retyping the set key", async () => {
        settings.set("meta-api-key", "secret-value-1234");
        settings.set("meta-models", "muse-spark-1.1");

        const form = await request(app).get("/install/items/ai-meta-key");
        expect(form.status).toBe(200);
        const keyInput = /<input id="f-meta-api-key"[^>]*>/.exec(form.text)?.[0] ?? "";
        expect(keyInput).toContain('type="password"');
        expect(keyInput).not.toContain("required");
        expect(keyInput).not.toContain("value=");
        expect(form.text).not.toContain("secret-value-1234");

        const res = await save("ai-meta-key", { "meta-api-key": "", "meta-models": "muse-spark-1.2" });
        expect(res.status).toBe(303);
        expect(setConfig.mock.calls).toEqual([["meta-models", "muse-spark-1.2"]]);
    });

    it("still requires the key the first time", async () => {
        const res = await save("ai-meta-key", { "meta-api-key": "", "meta-models": "muse-spark-1.1" });
        expect(res.status).toBe(400);
        expect(res.text).toContain("Meta API key is required.");
    });

    async function keyInput(): Promise<string> {
        const form = await request(app).get("/install/items/ai-meta-key");
        expect(form.status).toBe(200);
        return /<input id="f-meta-api-key"[^>]*>/.exec(form.text)?.[0] ?? "";
    }

    it("marks the key required on first setup", async () => {
        expect(await keyInput()).toMatch(/\srequired(\s|>)/);
    });

    it("marks the key required while it still holds the Bicep placeholder", async () => {
        settings.set("meta-api-key", "__unset__");
        expect(await keyInput()).toMatch(/\srequired(\s|>)/);
    });

    it("does not mark the key required once it is really set", async () => {
        settings.set("meta-api-key", "secret-value-1234");
        expect(await keyInput()).not.toMatch(/\srequired(\s|>)/);
    });

    it("never shows the placeholder as a current value", async () => {
        settings.set("meta-api-key", "__unset__");
        settings.set("meta-base-url", "__unset__");
        const form = await request(app).get("/install/items/ai-meta-key");
        expect(form.text).not.toContain("__unset__");
        expect(form.text).not.toContain("Currently");
    });

    it("refuses a blank key on the server while it holds the placeholder", async () => {
        settings.set("meta-api-key", "__unset__");
        const res = await save("ai-meta-key", { "meta-api-key": "", "meta-models": "muse-spark-1.1" });
        expect(res.status).toBe(400);
        expect(res.text).toContain("Meta API key is required.");
        expect(setConfig).not.toHaveBeenCalled();
    });
});
