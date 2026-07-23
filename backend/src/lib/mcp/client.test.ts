import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getConfigMock, dnsLookupMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  dnsLookupMock: vi.fn(),
}));

vi.mock("../config", () => ({ getConfig: getConfigMock }));
// validateRemoteMcpUrl resolves hostnames to check for private ranges —
// never let tests do live DNS.
vi.mock("dns/promises", () => ({
  default: { lookup: dnsLookupMock },
}));

import {
  encryptString,
  decryptString,
  flushMcpEncryptionKey,
  mcpOAuthCallbackUrl,
  validateRemoteMcpUrl,
} from "./client";

const ENV_SNAPSHOT_KEYS = ["API_PUBLIC_URL", "BACKEND_URL", "PORT"] as const;
const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of ENV_SNAPSHOT_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  getConfigMock.mockReset();
  dnsLookupMock.mockReset();
  // The derived key is cached module-level across calls — flush between
  // tests or the first test's secret wins forever.
  flushMcpEncryptionKey();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_SNAPSHOT_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

function configuredWith(secrets: Record<string, string>) {
  getConfigMock.mockImplementation((name: string) =>
    name in secrets
      ? Promise.resolve(secrets[name])
      : Promise.reject(new Error(`no config for ${name}`)),
  );
}

describe("encryptString / decryptString", () => {
  it("round-trips a secret under mcp-connectors-encryption-key", async () => {
    configuredWith({ "mcp-connectors-encryption-key": "mcp-secret-32-chars-or-longer-xx" });

    const { encrypted, iv, tag } = await encryptString("ghp_bearer_token");

    expect(encrypted).not.toContain("ghp_bearer_token");
    expect(await decryptString(encrypted, iv, tag)).toBe("ghp_bearer_token");
  });

  it("falls back to user-api-keys-encryption-key when the MCP secret is absent", async () => {
    configuredWith({ "user-api-keys-encryption-key": "shared-secret-32-chars-or-longer" });

    const { encrypted, iv, tag } = await encryptString("value");

    expect(getConfigMock).toHaveBeenCalledWith("mcp-connectors-encryption-key");
    expect(getConfigMock).toHaveBeenCalledWith("user-api-keys-encryption-key");
    expect(await decryptString(encrypted, iv, tag)).toBe("value");
  });

  it("throws a descriptive error when neither secret is configured (the image-only-upgrade landmine)", async () => {
    configuredWith({});

    await expect(encryptString("value")).rejects.toThrow(
      /mcp-connectors-encryption-key.*is not configured/s,
    );
  });

  it("returns null (not garbage, not a throw) when the ciphertext is tampered", async () => {
    configuredWith({ "mcp-connectors-encryption-key": "mcp-secret-32-chars-or-longer-xx" });
    const { iv, tag } = await encryptString("value");
    const tampered = Buffer.from("evil").toString("base64");

    expect(await decryptString(tampered, iv, tag)).toBeNull();
  });

  it("returns null when any ciphertext component is missing", async () => {
    expect(await decryptString(null, "iv", "tag")).toBeNull();
    expect(await decryptString("enc", undefined, "tag")).toBeNull();
    expect(await decryptString("enc", "iv", "")).toBeNull();
  });

  it("flushMcpEncryptionKey forces the next call to re-read the secret (rotation)", async () => {
    configuredWith({ "mcp-connectors-encryption-key": "first-secret-32-chars-or-longer-" });
    await encryptString("a");
    const callsBefore = getConfigMock.mock.calls.length;

    await encryptString("b"); // cached — no new getConfig
    expect(getConfigMock.mock.calls.length).toBe(callsBefore);

    flushMcpEncryptionKey();
    await encryptString("c");
    expect(getConfigMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("mcpOAuthCallbackUrl", () => {
  it("prefers API_PUBLIC_URL, trimming trailing slashes", () => {
    process.env.API_PUBLIC_URL = "https://mike.example.com///";

    expect(mcpOAuthCallbackUrl()).toBe(
      "https://mike.example.com/user/mcp-connectors/oauth/callback",
    );
  });

  it("falls back to BACKEND_URL, then localhost with the configured port", () => {
    process.env.BACKEND_URL = "https://backend.internal";
    expect(mcpOAuthCallbackUrl()).toBe(
      "https://backend.internal/user/mcp-connectors/oauth/callback",
    );

    delete process.env.BACKEND_URL;
    process.env.PORT = "4123";
    expect(mcpOAuthCallbackUrl()).toBe(
      "http://localhost:4123/user/mcp-connectors/oauth/callback",
    );
  });
});

describe("validateRemoteMcpUrl — SSRF guard", () => {
  it("rejects non-URLs and non-HTTPS schemes", async () => {
    await expect(validateRemoteMcpUrl("not a url")).rejects.toThrow(
      /valid URL/,
    );
    await expect(validateRemoteMcpUrl("http://mcp.example.com")).rejects.toThrow(
      /HTTPS/,
    );
  });

  it("rejects localhost and *.localhost without a DNS lookup", async () => {
    await expect(validateRemoteMcpUrl("https://localhost/mcp")).rejects.toThrow(
      /blocked host/,
    );
    await expect(
      validateRemoteMcpUrl("https://evil.localhost/mcp"),
    ).rejects.toThrow(/blocked host/);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("rejects literal private / loopback / metadata addresses", async () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.8",
      "192.168.1.10",
      "169.254.169.254",
    ]) {
      await expect(validateRemoteMcpUrl(`https://${host}/mcp`)).rejects.toThrow(
        /blocked/,
      );
    }
    expect(dnsLookupMock).not.toHaveBeenCalled();

    // Bracketed IPv6 literals keep their brackets in URL.hostname, so
    // net.isIP() misses them and they go through the resolver path.
    dnsLookupMock.mockResolvedValueOnce([{ address: "::1" }]);
    await expect(validateRemoteMcpUrl("https://[::1]/mcp")).rejects.toThrow(
      /blocked/,
    );
  });

  it("rejects a public hostname that RESOLVES to a private address (DNS rebinding)", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "10.20.30.40" }]);

    await expect(
      validateRemoteMcpUrl("https://rebind.example.com/mcp"),
    ).rejects.toThrow(/blocked network address/);
  });

  it("accepts a public host and strips credentials + fragment from the URL", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "93.184.216.34" }]);

    const out = await validateRemoteMcpUrl(
      "https://user:pass@mcp.example.com/sse#frag",
    );

    expect(out).toBe("https://mcp.example.com/sse");
  });
});
