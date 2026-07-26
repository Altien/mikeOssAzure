import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";

export const SKILL_IMPORT_LIMITS = {
  compressedBytes: 1 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024,
  files: 50,
  fileBytes: 500 * 1024,
  skillMarkdownBytes: 64 * 1024,
} as const;

export type SkillSnapshotFile = {
  relativePath: string;
  bytes: Uint8Array;
  byteSize: number;
  sha256: string;
  mediaType: string;
  inspectionClass: "text" | "source" | "binary" | "nested_archive";
};

export type DiscoveredSkill = {
  entrypointPath: string;
  rootPath: string;
  declaredName: string;
  description: string;
  declaredVersion?: string;
  frontmatter: Record<string, string>;
  frontmatterRaw: string;
  instructionMarkdown: string;
  licencePaths: string[];
};

export type ValidatedSkillSnapshot = {
  files: SkillSnapshotFile[];
  skills: DiscoveredSkill[];
  treeHash: string;
  expandedBytes: number;
  licencePaths: string[];
  warnings: string[];
};

export class SkillArchiveValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillArchiveValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new SkillArchiveValidationError(code, message);
}

function normalizeArchivePath(rawPath: string): string {
  if (
    rawPath.includes("\0") ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(rawPath)
  ) {
    fail("unsafe_path", `Unsafe archive path '${rawPath}'.`);
  }
  const slashPath = rawPath.replace(/\\/g, "/");
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    fail("unsafe_path", `Unsafe archive path '${rawPath}'.`);
  }
  const normalized = path.posix.normalize(slashPath).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    fail("unsafe_path", `Unsafe archive path '${rawPath}'.`);
  }
  return normalized.replace(/\/+$/, "");
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions =
    typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  return (permissions & 0o170000) === 0o120000;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".html",
  ".svg",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".ps1",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".fs",
  ".fsx",
]);

const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
]);

function classifyFile(relativePath: string) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension)) {
    return {
      mediaType: "text/plain; charset=utf-8",
      inspectionClass: "source" as const,
    };
  }
  if (TEXT_EXTENSIONS.has(extension) || path.posix.basename(relativePath) === "SKILL.md") {
    const mediaType =
      extension === ".json"
        ? "application/json"
        : extension === ".svg"
          ? "image/svg+xml"
          : extension === ".html"
            ? "text/html; charset=utf-8"
            : "text/plain; charset=utf-8";
    return { mediaType, inspectionClass: "text" as const };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return {
      mediaType: "application/octet-stream",
      inspectionClass: "nested_archive" as const,
    };
  }
  return {
    mediaType: "application/octet-stream",
    inspectionClass: "binary" as const,
  };
}

function decodeText(file: SkillSnapshotFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    fail("invalid_utf8", `'${file.relativePath}' is not valid UTF-8.`);
  }
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      fail("invalid_frontmatter", "Invalid quoted YAML scalar.");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseFrontmatter(text: string, entrypointPath: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    fail(
      "invalid_frontmatter",
      `'${entrypointPath}' must begin with YAML frontmatter.`,
    );
  }
  const close = normalized.indexOf("\n---\n", 4);
  if (close < 0) {
    fail(
      "invalid_frontmatter",
      `'${entrypointPath}' has no closing frontmatter delimiter.`,
    );
  }
  const raw = normalized.slice(4, close);
  const body = normalized.slice(close + 5).trim();
  if (!body) {
    fail(
      "invalid_skill",
      `'${entrypointPath}' must contain skill instructions.`,
    );
  }

  const values: Record<string, string> = {};
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;
    const [, key, rawValue = ""] = match;
    if (/^[|>][+-]?$/.test(rawValue)) {
      const chunks: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        chunks.push(lines[index].replace(/^\s+/, ""));
      }
      values[key] =
        rawValue.startsWith(">")
          ? chunks.join(" ").trim()
          : chunks.join("\n").trim();
    } else {
      values[key] = unquoteYamlScalar(rawValue);
    }
  }

  const name = values.name?.trim();
  const description = values.description?.trim();
  if (!name || name.length > 128) {
    fail(
      "invalid_skill_name",
      `'${entrypointPath}' requires a name of at most 128 characters.`,
    );
  }
  if (!description) {
    fail(
      "invalid_skill_description",
      `'${entrypointPath}' requires a description.`,
    );
  }
  return {
    values,
    raw,
    body,
    name,
    description,
    declaredVersion: values.version?.trim() || undefined,
  };
}

function isLicencePath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return /^(licen[cs]e|copying|notice)(?:[._-].*)?$/.test(basename);
}

const HIGH_CONFIDENCE_CREDENTIALS: Array<{
  type: string;
  pattern: RegExp;
}> = [
  {
    type: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    type: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  },
  {
    type: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    type: "credential URL",
    pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    type: "environment credential",
    pattern:
      /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*(?!example|placeholder|changeme|your[_-])/i,
  },
];

function scanCredentials(file: SkillSnapshotFile): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return;
  }
  for (const credential of HIGH_CONFIDENCE_CREDENTIALS) {
    if (credential.pattern.test(text)) {
      fail(
        "credential_detected",
        `Import rejected: ${credential.type} detected in '${file.relativePath}'.`,
      );
    }
  }
}

function canonicalTreeHash(files: SkillSnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "en"),
  )) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.sha256, "ascii");
    hash.update("\0");
    hash.update(String(file.byteSize), "ascii");
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function validateSkillZip(
  input: Uint8Array,
): Promise<ValidatedSkillSnapshot> {
  if (input.byteLength > SKILL_IMPORT_LIMITS.compressedBytes) {
    fail(
      "compressed_size_limit",
      `ZIP exceeds the ${SKILL_IMPORT_LIMITS.compressedBytes} byte limit.`,
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input, { createFolders: true });
  } catch {
    fail("invalid_zip", "The uploaded file is not a supported ZIP archive.");
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > SKILL_IMPORT_LIMITS.files) {
    fail(
      "file_count_limit",
      `ZIP contains more than ${SKILL_IMPORT_LIMITS.files} files.`,
    );
  }

  const seen = new Map<string, string>();
  const files: SkillSnapshotFile[] = [];
  let expandedBytes = 0;
  for (const entry of entries) {
    const originalName =
      (entry as JSZip.JSZipObject & { unsafeOriginalName?: string })
        .unsafeOriginalName ?? entry.name;
    const relativePath = normalizeArchivePath(originalName);
    const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en");
    const previous = seen.get(collisionKey);
    if (previous) {
      fail(
        "path_collision",
        `Archive paths '${previous}' and '${relativePath}' collide.`,
      );
    }
    seen.set(collisionKey, relativePath);
    if (isSymlink(entry)) {
      fail("symlink", `Symlink '${relativePath}' is not allowed.`);
    }
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength > SKILL_IMPORT_LIMITS.fileBytes) {
      fail(
        "file_size_limit",
        `'${relativePath}' exceeds the ${SKILL_IMPORT_LIMITS.fileBytes} byte limit.`,
      );
    }
    if (
      path.posix.basename(relativePath) === "SKILL.md" &&
      bytes.byteLength > SKILL_IMPORT_LIMITS.skillMarkdownBytes
    ) {
      fail(
        "skill_markdown_size_limit",
        `'${relativePath}' exceeds the ${SKILL_IMPORT_LIMITS.skillMarkdownBytes} byte SKILL.md limit.`,
      );
    }
    expandedBytes += bytes.byteLength;
    if (expandedBytes > SKILL_IMPORT_LIMITS.expandedBytes) {
      fail(
        "expanded_size_limit",
        `Expanded ZIP exceeds the ${SKILL_IMPORT_LIMITS.expandedBytes} byte limit.`,
      );
    }
    const classification = classifyFile(relativePath);
    files.push({
      relativePath,
      bytes,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      ...classification,
    });
  }

  if (!files.length) fail("empty_archive", "ZIP contains no files.");
  for (const file of files) scanCredentials(file);

  const licencePaths = files
    .filter((file) => isLicencePath(file.relativePath))
    .map((file) => file.relativePath)
    .sort();
  const skills = files
    .filter((file) => path.posix.basename(file.relativePath) === "SKILL.md")
    .map((file): DiscoveredSkill => {
      const parsed = parseFrontmatter(decodeText(file), file.relativePath);
      const rootPath = path.posix.dirname(file.relativePath);
      const normalizedRoot = rootPath === "." ? "" : `${rootPath}/`;
      return {
        entrypointPath: file.relativePath,
        rootPath: rootPath === "." ? "" : rootPath,
        declaredName: parsed.name,
        description: parsed.description,
        declaredVersion: parsed.declaredVersion,
        frontmatter: parsed.values,
        frontmatterRaw: parsed.raw,
        instructionMarkdown: parsed.body,
        licencePaths: licencePaths.filter(
          (licencePath) =>
            !normalizedRoot || licencePath.startsWith(normalizedRoot),
        ),
      };
    });
  if (!skills.length) {
    fail("skill_missing", "ZIP contains no SKILL.md entrypoint.");
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
  skills.sort((a, b) =>
    a.entrypointPath.localeCompare(b.entrypointPath, "en"),
  );
  return {
    files,
    skills,
    treeHash: canonicalTreeHash(files),
    expandedBytes,
    licencePaths,
    warnings: [],
  };
}
