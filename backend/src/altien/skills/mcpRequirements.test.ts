import { describe, expect, it } from "vitest";
import { detectMcpRequirements } from "./mcpRequirements";
import type { SkillSnapshotFile } from "./archive";

function config(value: unknown): SkillSnapshotFile {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    relativePath: ".mcp.json",
    bytes,
    byteSize: bytes.length,
    sha256: "hash",
    mediaType: "application/json",
    inspectionClass: "text",
  };
}

describe("detectMcpRequirements", () => {
  it("separates remote connector requirements from local MCP implementations", () => {
    const requirements = detectMcpRequirements([
      config({
        mcpServers: {
          remote: {
            url: "https://mcp.example.test/api",
            transport: "streamable_http",
            auth: "oauth",
          },
          local: {
            command: "npx",
            args: ["-y", "@example/local-mcp"],
            transport: "stdio",
          },
        },
      }),
    ]);
    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remote",
          endpoint: "https://mcp.example.test/api",
        }),
        expect.objectContaining({
          kind: "local",
          command: "npx",
          reason: "npx",
        }),
      ]),
    );
  });
});
