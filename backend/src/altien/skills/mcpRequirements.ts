import type { SkillSnapshotFile } from "./archive";

export type DetectedMcpRequirement =
  | {
      kind: "remote";
      sourcePath: string;
      name: string | null;
      endpoint: string;
      transport: string;
      auth: string | null;
    }
  | {
      kind: "local";
      sourcePath: string;
      name: string | null;
      command: string;
      args: string[];
      reason: "command" | "stdio" | "npx" | "uvx" | "local_path";
    };

function walk(
  value: unknown,
  sourcePath: string,
  requirements: DetectedMcpRequirement[],
  inheritedName: string | null = null,
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, sourcePath, requirements, inheritedName);
    return;
  }
  const row = value as Record<string, unknown>;
  const name =
    typeof row.name === "string" ? row.name : inheritedName;
  const endpoint =
    typeof row.url === "string"
      ? row.url
      : typeof row.serverUrl === "string"
        ? row.serverUrl
        : null;
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        requirements.push({
          kind: "remote",
          sourcePath,
          name,
          endpoint: parsed.toString(),
          transport:
            typeof row.transport === "string"
              ? row.transport
              : "streamable_http",
          auth: typeof row.auth === "string" ? row.auth : null,
        });
      }
    } catch {
      // Invalid endpoints remain analysis findings, not acquisition targets.
    }
  }
  const command = typeof row.command === "string" ? row.command.trim() : "";
  if (command) {
    const args = Array.isArray(row.args)
      ? row.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const lower = command.toLocaleLowerCase();
    const reason =
      lower === "npx"
        ? "npx"
        : lower === "uvx"
          ? "uvx"
          : row.transport === "stdio"
            ? "stdio"
            : /[\\/]|\.([cm]?js|ts|py|sh|exe)$/i.test(command)
              ? "local_path"
              : "command";
    requirements.push({
      kind: "local",
      sourcePath,
      name,
      command,
      args,
      reason,
    });
  }
  for (const [key, child] of Object.entries(row)) {
    if (child && typeof child === "object") {
      walk(child, sourcePath, requirements, name ?? key);
    }
  }
}

export function detectMcpRequirements(files: SkillSnapshotFile[]) {
  const requirements: DetectedMcpRequirement[] = [];
  for (const file of files) {
    if (
      file.inspectionClass !== "text" &&
      file.inspectionClass !== "source"
    ) {
      continue;
    }
    if (!/(\.json|\.jsonc)$/i.test(file.relativePath)) continue;
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    } catch {
      continue;
    }
    walk(parsed, file.relativePath, requirements);
  }
  const unique = new Map<string, DetectedMcpRequirement>();
  for (const requirement of requirements) {
    const key =
      requirement.kind === "remote"
        ? `remote:${requirement.endpoint}`
        : `local:${requirement.sourcePath}:${requirement.command}:${requirement.args.join("\0")}`;
    unique.set(key, requirement);
  }
  return [...unique.values()];
}
