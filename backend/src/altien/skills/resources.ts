import { downloadFile } from "../../lib/storage";
import type { createServerSupabase } from "../../lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const SKILL_RESOURCE_TOOL_NAMES = {
  list: "list_skill_resources",
  read: "read_skill_resource",
  search: "search_skill_resources",
} as const;

export const SKILL_RESOURCE_TOOLS = [
  {
    type: "function",
    function: {
      name: SKILL_RESOURCE_TOOL_NAMES.list,
      description:
        "List immutable skill-package resources with path, hash, media type, and text-readability.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: SKILL_RESOURCE_TOOL_NAMES.read,
      description:
        "Read a bounded portion of one textual skill resource by its exact preserved relative path. Binary and nested archive files remain inert.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          max_chars: { type: "integer", minimum: 1, maximum: 40000 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SKILL_RESOURCE_TOOL_NAMES.search,
      description:
        "Search textual skill resources for a literal case-insensitive query and return bounded contexts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["query"],
      },
    },
  },
] as const;

type ResourceRecord = {
  path: string;
  bytes: number;
  media_type: string;
  inspection_class: "text" | "source" | "binary" | "nested_archive";
  document_version_id: string;
  sha256: string;
};

function isReadable(resource: ResourceRecord) {
  return (
    resource.inspection_class === "text" ||
    resource.inspection_class === "source"
  );
}

export class SkillResourceStore {
  private readonly byPath: Map<string, ResourceRecord>;

  constructor(
    resources: ResourceRecord[],
    private readonly db: Db,
  ) {
    this.byPath = new Map(
      resources.map((resource) => [resource.path, resource]),
    );
  }

  list() {
    return [...this.byPath.values()]
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
      .map((resource) => ({
        path: resource.path,
        bytes: resource.bytes,
        sha256: resource.sha256,
        media_type: resource.media_type,
        readable: isReadable(resource),
        inert_reason: isReadable(resource)
          ? null
          : resource.inspection_class === "nested_archive"
            ? "nested_archive"
            : "binary",
      }));
  }

  private exact(path: unknown): ResourceRecord {
    if (typeof path !== "string" || !path || path.includes("\0")) {
      throw new Error("A valid exact resource path is required.");
    }
    const resource = this.byPath.get(path);
    if (!resource) throw new Error("Skill resource not found.");
    return resource;
  }

  private async text(resource: ResourceRecord): Promise<string> {
    if (!isReadable(resource)) {
      throw new Error(
        `Skill resource '${resource.path}' is inert and cannot be read as text.`,
      );
    }
    const version = await this.db
      .from("document_versions")
      .select("storage_path")
      .eq("id", resource.document_version_id)
      .single();
    if (version.error || !version.data?.storage_path) {
      throw new Error("Skill resource document version is unavailable.");
    }
    const bytes = await downloadFile(String(version.data.storage_path));
    if (!bytes) throw new Error("Skill resource blob is unavailable.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async read(args: { path: unknown; offset?: unknown; max_chars?: unknown }) {
    const resource = this.exact(args.path);
    const text = await this.text(resource);
    const offset =
      typeof args.offset === "number" && Number.isFinite(args.offset)
        ? Math.max(0, Math.floor(args.offset))
        : 0;
    const maxChars =
      typeof args.max_chars === "number" && Number.isFinite(args.max_chars)
        ? Math.min(40_000, Math.max(1, Math.floor(args.max_chars)))
        : 20_000;
    return {
      path: resource.path,
      sha256: resource.sha256,
      offset,
      text: text.slice(offset, offset + maxChars),
      truncated: offset + maxChars < text.length,
      total_chars: text.length,
      content_disposition: "plain_text_data",
    };
  }

  async search(args: { query: unknown; max_results?: unknown }) {
    if (
      typeof args.query !== "string" ||
      !args.query.trim() ||
      args.query.length > 500
    ) {
      throw new Error("A search query of at most 500 characters is required.");
    }
    const query = args.query.toLocaleLowerCase();
    const limit =
      typeof args.max_results === "number" &&
      Number.isFinite(args.max_results)
        ? Math.min(30, Math.max(1, Math.floor(args.max_results)))
        : 20;
    const matches: Array<{ path: string; offset: number; context: string }> = [];
    for (const resource of this.byPath.values()) {
      if (!isReadable(resource)) continue;
      const text = await this.text(resource);
      const lower = text.toLocaleLowerCase();
      let from = 0;
      while (matches.length < limit) {
        const index = lower.indexOf(query, from);
        if (index < 0) break;
        matches.push({
          path: resource.path,
          offset: index,
          context: text.slice(
            Math.max(0, index - 100),
            index + query.length + 100,
          ),
        });
        from = index + Math.max(1, query.length);
      }
      if (matches.length >= limit) break;
    }
    return { query: args.query, matches, truncated: matches.length >= limit };
  }
}

export async function dispatchSkillResourceTool(args: {
  name: string;
  input: Record<string, unknown>;
  store?: SkillResourceStore;
}) {
  if (!args.store) throw new Error("No skill package is bound to this chat.");
  if (args.name === SKILL_RESOURCE_TOOL_NAMES.list) return args.store.list();
  if (args.name === SKILL_RESOURCE_TOOL_NAMES.read) {
    return args.store.read({
      path: args.input.path,
      offset: args.input.offset,
      max_chars: args.input.max_chars,
    });
  }
  if (args.name === SKILL_RESOURCE_TOOL_NAMES.search) {
    return args.store.search({
      query: args.input.query,
      max_results: args.input.max_results,
    });
  }
  throw new Error(`Unknown skill resource tool '${args.name}'.`);
}
