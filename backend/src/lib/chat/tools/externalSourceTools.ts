export const EXTERNAL_SOURCE_TOOL_NAMES = {
  search: "search_external_source",
  read: "read_external_source",
} as const;

export const EXTERNAL_SOURCE_SYSTEM_PROMPT = `EXTERNAL SOURCE ACCESS:
When a retrieval or download tool returns an external_source_id, the complete source is cached server-side and its returned summary is orientation only. Use search_external_source to locate relevant passages and read_external_source to inspect the necessary text. Do not cite or verify a proposition from the summary alone.`;

export const EXTERNAL_SOURCE_TOOLS = [
  {
    type: "function",
    function: {
      name: EXTERNAL_SOURCE_TOOL_NAMES.search,
      description:
        "Search the complete server-cached text of an external source downloaded in this assistant turn. Use the external_source_id returned by the retrieval tool. Returns exact passages with surrounding context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          external_source_id: {
            type: "string",
            description:
              "Server-issued external_source_id returned by a retrieval or download tool in this turn.",
          },
          query: {
            type: "string",
            description:
              "A short word or phrase likely to occur in the source text.",
          },
          max_results: {
            type: "integer",
            description: "Maximum passages to return. Default 20.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of context to return on each side. Default 240.",
          },
        },
        required: ["external_source_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: EXTERNAL_SOURCE_TOOL_NAMES.read,
      description:
        "Read a bounded range from the complete server-cached text of an external source downloaded in this assistant turn. Use search_external_source first when the source is long.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          external_source_id: {
            type: "string",
            description:
              "Server-issued external_source_id returned by a retrieval or download tool in this turn.",
          },
          start: {
            type: "integer",
            description: "Zero-based character offset. Default 0.",
          },
          max_chars: {
            type: "integer",
            description:
              "Maximum characters to return. Default 12,000; maximum 50,000.",
          },
        },
        required: ["external_source_id"],
      },
    },
  },
] as const;
