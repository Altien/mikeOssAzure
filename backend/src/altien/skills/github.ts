import JSZip from "jszip";
import { SKILL_IMPORT_LIMITS, validateSkillZip } from "./archive";

export type ParsedGitHubSource = {
  owner: string;
  repository: string;
  treeTail: string[];
};

export class GitHubSkillImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHubSkillImportError";
  }
}

export function parseGitHubSourceUrl(raw: string): ParsedGitHubSource {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GitHubSkillImportError(
      "invalid_github_url",
      "A valid github.com repository URL is required.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLocaleLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new GitHubSkillImportError(
      "invalid_github_url",
      "Only HTTPS github.com repository URLs are allowed.",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length < 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])
  ) {
    throw new GitHubSkillImportError(
      "invalid_github_url",
      "A valid github.com owner/repository URL is required.",
    );
  }
  const repository = parts[1].replace(/\.git$/i, "");
  if (parts.length > 2 && parts[2] !== "tree") {
    throw new GitHubSkillImportError(
      "invalid_github_url",
      "GitHub imports accept a repository root or /tree/<ref>/<path> URL.",
    );
  }
  return {
    owner: parts[0],
    repository,
    treeTail: parts[2] === "tree" ? parts.slice(3) : [],
  };
}

type GitHubFetch = typeof fetch;

function headers(token?: string) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Mike-Skills-Importer",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson<T>(
  path: string,
  options: { fetcher: GitHubFetch; token?: string; allow404?: boolean },
): Promise<T | null> {
  const response = await options.fetcher(`https://api.github.com${path}`, {
    headers: headers(options.token),
    redirect: "follow",
  });
  if (response.url) {
    const final = new URL(response.url);
    if (final.protocol !== "https:" || final.hostname !== "api.github.com") {
      throw new GitHubSkillImportError(
        "github_redirect_rejected",
        "GitHub API redirected outside api.github.com.",
      );
    }
  }
  if (options.allow404 && response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new GitHubSkillImportError(
      "github_authorization_required",
      "The GitHub repository requires an authorized read-only connection.",
    );
  }
  if (response.status === 404) {
    throw new GitHubSkillImportError(
      "github_not_found",
      "GitHub repository or ref was not found.",
    );
  }
  if (!response.ok) {
    throw new GitHubSkillImportError(
      "github_request_failed",
      `GitHub API request failed with status ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

async function resolveRefAndPath(args: {
  parsed: ParsedGitHubSource;
  defaultBranch: string;
  fetcher: GitHubFetch;
  token?: string;
}) {
  if (!args.parsed.treeTail.length) {
    const commit = await githubJson<{ sha: string }>(
      `/repos/${encodeURIComponent(args.parsed.owner)}/${encodeURIComponent(args.parsed.repository)}/commits/${encodeURIComponent(args.defaultBranch)}`,
      args,
    );
    return {
      requestedRef: args.defaultBranch,
      selectedPath: "",
      commitSha: commit!.sha,
    };
  }
  for (
    let refSegments = args.parsed.treeTail.length;
    refSegments >= 1;
    refSegments -= 1
  ) {
    const requestedRef = args.parsed.treeTail
      .slice(0, refSegments)
      .join("/");
    const commit = await githubJson<{ sha: string } | null>(
      `/repos/${encodeURIComponent(args.parsed.owner)}/${encodeURIComponent(args.parsed.repository)}/commits/${encodeURIComponent(requestedRef)}`,
      { ...args, allow404: true },
    );
    if (commit) {
      return {
        requestedRef,
        selectedPath: args.parsed.treeTail.slice(refSegments).join("/"),
        commitSha: commit.sha,
      };
    }
  }
  throw new GitHubSkillImportError(
    "github_ref_not_found",
    "No commit ref in the GitHub tree URL could be resolved.",
  );
}

export async function acquireGitHubSkill(args: {
  url: string;
  fetcher?: GitHubFetch;
  token?: string;
}) {
  const parsed = parseGitHubSourceUrl(args.url);
  const fetcher = args.fetcher ?? fetch;
  const common = { fetcher, token: args.token };
  const repository = await githubJson<{
    default_branch: string;
    private: boolean;
    full_name: string;
  }>(
    `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`,
    common,
  );
  const resolved = await resolveRefAndPath({
    parsed,
    defaultBranch: repository!.default_branch,
    ...common,
  });
  const tree = await githubJson<{
    truncated: boolean;
    tree: Array<{
      path: string;
      mode: string;
      type: "blob" | "tree" | "commit";
      sha: string;
      size?: number;
    }>;
  }>(
    `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}/git/trees/${encodeURIComponent(resolved.commitSha)}?recursive=1`,
    common,
  );
  if (tree!.truncated) {
    throw new GitHubSkillImportError(
      "github_tree_truncated",
      "GitHub returned a truncated repository tree.",
    );
  }
  const prefix = resolved.selectedPath
    ? `${resolved.selectedPath.replace(/^\/+|\/+$/g, "")}/`
    : "";
  const blobs = tree!.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        (!prefix || item.path.startsWith(prefix)),
    )
    .map((item) => ({
      ...item,
      relativePath: prefix ? item.path.slice(prefix.length) : item.path,
    }));
  if (tree!.tree.some((item) => item.type === "commit" && (!prefix || item.path.startsWith(prefix)))) {
    throw new GitHubSkillImportError(
      "github_submodule_rejected",
      "Git submodules are not imported.",
    );
  }
  if (!blobs.length) {
    throw new GitHubSkillImportError(
      "github_path_empty",
      "The selected GitHub path contains no files.",
    );
  }
  if (blobs.length > SKILL_IMPORT_LIMITS.files) {
    throw new GitHubSkillImportError(
      "file_count_limit",
      `GitHub snapshot contains more than ${SKILL_IMPORT_LIMITS.files} files.`,
    );
  }
  let expanded = 0;
  for (const blob of blobs) {
    const size = blob.size ?? 0;
    if (size > SKILL_IMPORT_LIMITS.fileBytes) {
      throw new GitHubSkillImportError(
        "file_size_limit",
        `'${blob.relativePath}' exceeds the per-file limit.`,
      );
    }
    expanded += size;
    if (expanded > SKILL_IMPORT_LIMITS.expandedBytes) {
      throw new GitHubSkillImportError(
        "expanded_size_limit",
        "GitHub snapshot exceeds the expanded-size limit.",
      );
    }
  }
  const zip = new JSZip();
  const stableDate = new Date("1980-01-01T00:00:00.000Z");
  for (const blob of blobs.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "en"),
  )) {
    const payload = await githubJson<{
      encoding: string;
      content: string;
      size: number;
    }>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}/git/blobs/${encodeURIComponent(blob.sha)}`,
      common,
    );
    if (payload!.encoding !== "base64") {
      throw new GitHubSkillImportError(
        "github_blob_encoding",
        "GitHub returned an unsupported blob encoding.",
      );
    }
    const bytes = Buffer.from(payload!.content.replace(/\s/g, ""), "base64");
    if (bytes.byteLength !== payload!.size) {
      throw new GitHubSkillImportError(
        "github_blob_size",
        `GitHub blob size mismatch for '${blob.relativePath}'.`,
      );
    }
    zip.file(blob.relativePath, bytes, {
      binary: true,
      createFolders: true,
      date: stableDate,
    });
  }
  const sourceBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  const snapshot = await validateSkillZip(sourceBytes);
  return {
    sourceBytes,
    snapshot,
    provenance: {
      repository: `github.com/${parsed.owner}/${parsed.repository}`,
      selectedPath: resolved.selectedPath,
      requestedRef: resolved.requestedRef,
      resolvedCommitSha: resolved.commitSha,
      private: repository!.private,
    },
  };
}

export function githubDeploymentAllowed() {
  return process.env.ALLOW_GITHUB_SKILL_IMPORTS === "true";
}

export async function checkGitHubSourceUpdate(args: {
  repository: string;
  requestedRef: string;
  selectedPath: string;
  lastResolvedCommitSha: string;
  token?: string;
  fetcher?: GitHubFetch;
}) {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(args.repository);
  if (!match) {
    throw new GitHubSkillImportError(
      "invalid_github_provenance",
      "Stored GitHub repository provenance is invalid.",
    );
  }
  const fetcher = args.fetcher ?? fetch;
  const commit = await githubJson<{ sha: string }>(
    `/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/commits/${encodeURIComponent(args.requestedRef)}`,
    { fetcher, token: args.token },
  );
  if (!commit?.sha) {
    throw new GitHubSkillImportError(
      "github_ref_not_found",
      "The tracked GitHub ref could not be resolved.",
    );
  }
  return {
    repository: args.repository,
    requestedRef: args.requestedRef,
    selectedPath: args.selectedPath,
    previousCommitSha: args.lastResolvedCommitSha,
    currentCommitSha: commit.sha,
    updateAvailable: commit.sha !== args.lastResolvedCommitSha,
  };
}
