import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError,
}));

import { decryptAuthConfig, decryptString, encryptString, flushMcpEncryptionKey } from "../client";
import type { ConnectorRow } from "../types";

// Dev drift: KV-first cipher helpers are asynchronous and use the canonical local secret name.
vi.mock("../../config", () => ({ getKeyVaultConfig: vi.fn(async () => "") }));
const SECRET_VAR = "MCP_CONNECTORS_ENCRYPTION_KEY";
let previousSecret: string | undefined;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    previousSecret = process.env[SECRET_VAR];
    process.env[SECRET_VAR] = "test-secret-for-connector-decryption";
    flushMcpEncryptionKey();
    reportError.mockClear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    if (previousSecret === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = previousSecret;
    flushMcpEncryptionKey();
    errorSpy.mockRestore();
});

// A secret that no longer decrypts (rotated key, corrupt row) only ever
// surfaced as "the connector stopped working". It is now reported under its
// kind, with the cipher's error as the cause; the message stays in the log.
describe("connector secret decryption failures", () => {
    it("round-trips an intact secret without reporting", async () => {
        const { encrypted, iv, tag } = await encryptString("token-123");
        expect(await decryptString(encrypted, iv, tag)).toBe("token-123");
        expect(reportError).not.toHaveBeenCalled();
    });

    it("reports a secret that fails to decrypt under mcp.decrypt_failed and returns null", async () => {
        const { encrypted, iv } = await encryptString("token-123");
        const badTag = Buffer.alloc(16, 1).toString("base64");

        expect(await decryptString(encrypted, iv, badTag)).toBeNull();

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported] = reportError.mock.calls[0] as unknown as [{ kind: string; cause: unknown }];
        expect(reported.kind).toBe("mcp.decrypt_failed");
        expect(reported.cause).toBeInstanceOf(Error);
        expect(errorSpy).toHaveBeenCalledWith(
            "[mcp-connectors] failed to decrypt string secret",
            { error: reported },
        );
    });

    it("reports an auth config that fails to decrypt and falls back to an empty config", async () => {
        const { encrypted, iv } = await encryptString(JSON.stringify({ token: "t" }));
        const row = {
            id: "connector-1",
            encrypted_auth_config: encrypted,
            auth_config_iv: iv,
            auth_config_tag: Buffer.alloc(16, 2).toString("base64"),
        } as unknown as ConnectorRow;

        expect(await decryptAuthConfig(row)).toEqual({});

        expect(reportError).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "mcp.decrypt_failed" }),
        );
        expect(errorSpy).toHaveBeenCalledWith(
            "[mcp-connectors] failed to decrypt auth config",
            expect.objectContaining({ connectorId: "connector-1" }),
        );
    });
});
