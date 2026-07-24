import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({
    getConfigMock: vi.fn(),
}));

vi.mock("../config", () => ({ getConfig: getConfigMock }));

import { findManifestItem } from "./manifest";

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
                argsTemplate: "-ResourceGroup <rg>",
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
