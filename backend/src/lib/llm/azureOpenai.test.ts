import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider } from "./providers";

function completionResponse(text = "A short title") {
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }), {
        status: 200, headers: { "content-type": "application/json" },
    });
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Azure OpenAI AI SDK transport", () => {
    it("uses deployment Chat Completions URL, API key, version, and token field for an arbitrary alias", async () => {
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);
        await expect(completeWithProvider({
            model: "aoai:production", user: "Title this chat", maxTokens: 32,
            reasoningEffort: "none",
            apiKeys: { azureOpenai: {
                endpoint: "https://example.openai.azure.com/", apiKey: "org-key",
                apiVersion: "2024-10-21", deployment: "unused-default",
            } },
        })).resolves.toBe("A short title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://example.openai.azure.com/openai/deployments/production/chat/completions?api-version=2024-10-21");
        expect(new Headers(init.headers).get("api-key")).toBe("org-key");
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ model: "production", max_completion_tokens: 32, reasoning_effort: "none" });
        expect(body).not.toHaveProperty("max_tokens");
    });

    it("resolves the legacy default deployment without claiming keyless managed identity", async () => {
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);
        vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "legacy-deployment");
        await expect(completeWithProvider({
            model: "aoai:default", user: "Hello", apiKeys: { azureOpenai: {
                endpoint: "https://example.openai.azure.com", apiKey: "org-key", deployment: "",
            } },
        })).resolves.toBe("A short title");
        expect(fetchMock.mock.calls[0][0]).toContain("/deployments/legacy-deployment/chat/completions");
        await expect(completeWithProvider({
            model: "aoai:production", user: "Hello", apiKeys: { azureOpenai: {
                endpoint: "https://example.openai.azure.com", apiKey: "", deployment: "production",
            } },
        })).rejects.toThrow(/Azure OpenAI is not configured/);
    });
});

describe("OpenAI AI SDK transport", () => {
    it("uses the configured organisation base URL and Chat Completions by default", async () => {
        vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example/v1");
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);
        await expect(completeWithProvider({ model: "gpt-5.4", user: "Hello", apiKeys: { openai: "org-key" } })).resolves.toBe("A short title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://proxy.example/v1/chat/completions");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer org-key");
    });

    it("selects Responses only for the explicit deployment mode", async () => {
        vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example/v1");
        vi.stubEnv("OPENAI_API_MODE", "responses");
        const fetchMock = vi.fn().mockResolvedValue(new Response("mode probe", { status: 400 }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(completeWithProvider({ model: "gpt-5.4", user: "Hello", apiKeys: { openai: "org-key" } })).rejects.toThrow();
        expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/v1/responses");
    });
});
