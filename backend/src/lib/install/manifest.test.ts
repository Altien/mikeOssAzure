import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({
    getConfigMock: vi.fn(),
}));

vi.mock("../config", () => ({ getConfig: getConfigMock }));

import { findManifestItem } from "./manifest";

it("stores OpenCode Go once per organisation in its canonical Key Vault secret", () => {
    expect(findManifestItem("ai-opencode-go-key")).toMatchObject({
        required: false,
        fixedBy: { type: "in-app-form", submitTo: "kv", fields: [
            { name: "opencode-api-key", type: "password", required: true },
        ] },
    });
});

it("stores the direct Mistral credential once per organisation in Key Vault", () => {
    expect(findManifestItem("ai-mistral-key")).toMatchObject({
        section: "AI providers",
        required: false,
        fixedBy: { type: "in-app-form", submitTo: "kv", fields: [
            { name: "mistral-api-key", type: "password", required: true },
        ] },
    });
});

describe("administrator-entered provider rows", () => {
    const settings = new Map<string, string>();
    const context = { backendFqdn: "", keyVaultName: "", resourceGroup: "" };
    const check = (id: string) => findManifestItem(id)!.check(context);

    beforeEach(() => {
        settings.clear();
        getConfigMock.mockReset().mockImplementation(async (name: string) => settings.get(name) ?? "");
    });

    it("takes a redacted key, a URL and model names into Key Vault", () => {
        expect(findManifestItem("ai-tokenjuice-key")).toMatchObject({
            label: "TokenJuice",
            section: "AI providers",
            required: false,
            fixedBy: { type: "in-app-form", submitTo: "kv", fields: [
                { name: "tokenjuice-api-key", type: "password", required: true },
                { name: "tokenjuice-base-url", type: "url", required: true },
                { name: "tokenjuice-models", type: "text", required: true },
            ] },
        });
        expect(findManifestItem("ai-meta-key")).toMatchObject({
            label: "Meta (Muse)",
            section: "AI providers",
            required: false,
            fixedBy: { type: "in-app-form", submitTo: "kv", fields: [
                { name: "meta-api-key", type: "password", required: true },
                { name: "meta-base-url", type: "url", required: false, placeholder: "https://api.meta.ai/v1" },
                { name: "meta-models", type: "text", required: true },
            ] },
        });
    });

    it("stays unconfigured until every setting is present, and never shows the key", async () => {
        expect(await check("ai-tokenjuice-key")).toEqual({ status: "fail", detail: "Not yet configured." });
        settings.set("tokenjuice-api-key", "secret-tokenjuice-value");
        expect((await check("ai-tokenjuice-key")).status).toBe("fail");
        settings.set("tokenjuice-base-url", "https://tj.example.test/v1");
        expect((await check("ai-tokenjuice-key")).status).toBe("fail");
        settings.set("tokenjuice-models", "juice-large, juice-small");
        const passed = await check("ai-tokenjuice-key");
        expect(passed).toEqual({
            status: "pass",
            detail: "https://tj.example.test/v1 · juice-large, juice-small · key set",
        });
    });

    it("passes Meta on its default URL and says so", async () => {
        settings.set("meta-api-key", "secret-meta-value");
        settings.set("meta-models", "muse-spark-1.1");
        expect(await check("ai-meta-key")).toEqual({
            status: "pass",
            detail: "https://api.meta.ai/v1 (default) · muse-spark-1.1 · key set",
        });
    });

    it("reports a bad stored base URL as a format failure, with no fallback to the default", async () => {
        settings.set("meta-api-key", "secret-meta-value");
        settings.set("meta-models", "muse-spark-1.1");
        settings.set("meta-base-url", "ftp://meta.example.test");
        const result = await check("ai-meta-key");
        expect(result.status).toBe("fail");
        expect(result.detail).toMatch(/^Format check failed/);
        expect(result.detail).not.toContain("ftp://");
    });
});

describe("Kimi K3 install manifest item", () => {
    it("stores one organisation Moonshot key in Key Vault", () => {
        expect(findManifestItem("ai-kimi-key")).toMatchObject({
            label: "Kimi K3 API key",
            section: "AI providers",
            required: false,
            fixedBy: {
                type: "in-app-form",
                submitTo: "kv",
                fields: [
                    expect.objectContaining({
                        name: "moonshot-api-key",
                        type: "password",
                        required: true,
                    }),
                ],
            },
        });
    });
});

describe("Application Insights install manifest item", () => {
    const originalConnectionString =
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    beforeEach(() => {
        getConfigMock.mockReset();
        delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    });

    afterEach(() => {
        if (originalConnectionString === undefined) {
            delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
        } else {
            process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
                originalConnectionString;
        }
    });

    it("is required and points operators to the automated upgrade script", () => {
        const item = findManifestItem("app-insights-connection");

        expect(item).toMatchObject({
            section: "Core setup",
            required: true,
            fixedBy: {
                type: "external-script",
                scriptName: "upgrade-marketplace.ps1",
                argsTemplate: "-ResourceGroup <rg> -TargetVersion <target-version>",
            },
        });
    });

    it("fails when the running backend revision is not wired for telemetry", async () => {
        const item = findManifestItem("app-insights-connection");

        const result = await item!.check({} as never);

        expect(result).toEqual({
            status: "fail",
            detail: "Backend telemetry is not wired into this Container App revision.",
        });
        expect(getConfigMock).not.toHaveBeenCalled();
    });

    it("passes when the revision and Key Vault secret are both configured", async () => {
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
            "InstrumentationKey=test";
        getConfigMock.mockResolvedValue(
            "InstrumentationKey=test;IngestionEndpoint=https://example.test",
        );
        const item = findManifestItem("app-insights-connection");

        const result = await item!.check({} as never);

        expect(result).toEqual({
            status: "pass",
            detail: "Inst••••",
        });
        expect(getConfigMock).toHaveBeenCalledWith(
            "appinsights-connection-string",
        );
    });
});
