
export type { CourtlistenerToolEvent } from "@mike/contracts";

export type { CaseCitationEvent } from "@mike/contracts";

export const COURTLISTENER_TOOL_NAMES = {
    searchCaseLaw: "courtlistener_search_case_law",
    getCases: "courtlistener_get_cases",
    findInCase: "courtlistener_find_in_case",
    readCase: "courtlistener_read_case",
    verifyCitations: "courtlistener_verify_citations",
} as const;

export const COURTLISTENER_SYSTEM_PROMPT = `US CASE LAW RESEARCH:
Use CourtListener when answering US-law questions that require case law.

Workflow:
1. If you have reporter citations, verify them with courtlistener_verify_citations using only clean citations: {"citations":["467 U.S. 837","323 U.S. 134"]}. Never pass case names to this tool.
2. Fetch matched clusters with courtlistener_get_cases. It caches complete opinion text server-side and returns an orientation summary plus external_source_id for each opinion.
3. Get cite-worthy text from the cache with search_external_source, or with courtlistener_find_in_case when case-specific metadata is useful. Use short 1-3 word searches, maximum 3 searches per assistant turn.
4. If snippets are not enough, read only the necessary range with read_external_source, or use courtlistener_read_case for a selected opinion. For multi-opinion cases, choose only the opinion(s) needed; do not read all opinions by default.
5. When running Authority Trace, use the verification_source_id returned with a CourtListener passage or opinion as that source's document_id. Never invent this id.

Citation rules:
- Final case citations must be based on opinion text or passage snippets supplied in this turn. Do not cite cases based only on memory, metadata, search results, citationLinks, or verification results.
- If you mention a CourtListener case as legal support in the final answer, cite it with both: (a) the clickable markdown link returned in citationLinks, and (b) an inline [N] marker. Include the clickable case link only the first time you cite that case; later references to the same case should use the existing inline [N] marker without repeating the link unless clarity requires it.
- Assign new annotation refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
- The final <CITATIONS> block must include one matching case entry for each [N] case marker: {"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
- Do not use doc_id, page, top-level quote, case_name, or citation fields in case entries.
- If you have not obtained opinion text or snippets for a useful case, fetch/read it before citing it, or say you could not read it and do not rely on it.

Limits:
- If any CourtListener call returns a rate-limit/throttling/429 error, stop all CourtListener calls for that turn and answer using only information already available.`;

export const COURTLISTENER_TOOLS = [
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.getCases,
            description:
                "Fetch one or more CourtListener case clusters and cache their complete opinions server-side. Returns text-free metadata, an orientation summary, and external_source_id for each opinion. Use search_external_source/read_external_source to inspect the cached text.",
            parameters: {
                type: "object",
                properties: {
                    clusterIds: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "CourtListener cluster IDs from courtlistener_verify_citations or other case metadata already present in the conversation.",
                    },
                },
                required: ["clusterIds"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.findInCase,
            description:
                "Search within an already-fetched CourtListener case cluster for specific keyword(s) or phrases. Returns matches with surrounding opinion context. Call courtlistener_get_cases first; this tool does not fetch cases. Use no more than 3 calls to this tool in a single assistant turn.",
            parameters: {
                type: "object",
                properties: {
                    clusterId: {
                        type: "integer",
                        description:
                            "CourtListener cluster ID previously fetched with courtlistener_get_cases.",
                    },
                    query: {
                        type: "string",
                        description:
                            "Short term to search for, 1-3 words long and likely to appear exactly as written in the opinion text. Matching is case-insensitive and collapses whitespace.",
                    },
                    max_results: {
                        type: "integer",
                        description:
                            "Maximum number of matches to return. Default 20.",
                    },
                    context_chars: {
                        type: "integer",
                        description:
                            "Characters of surrounding context to include on each side of each match. Default 160.",
                    },
                },
                required: ["clusterId", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.readCase,
            description:
                "Read selected opinion text from an already-fetched CourtListener case cluster in this turn's cache. Use after courtlistener_find_in_case if snippets are insufficient. If the case has multiple opinions, pass only the opinionId/opinionIds needed. Call courtlistener_get_cases first; this tool does not fetch cases.",
            parameters: {
                type: "object",
                properties: {
                    clusterId: {
                        type: "integer",
                        description:
                            "CourtListener cluster ID previously fetched with courtlistener_get_cases.",
                    },
                    opinionId: {
                        type: "integer",
                        description:
                            "Specific opinion ID to read. Use when one opinion is enough.",
                    },
                    opinionIds: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "Specific opinion IDs to read. Use the smallest set needed; do not read all opinions unless the question requires it.",
                    },
                },
                required: ["clusterId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.verifyCitations,
            description:
                'Verify legal case citations using CourtListener\'s citation lookup. Accepts only an array of clean reporter citations, not case names. Example: {"citations":["467 U.S. 837","323 U.S. 134"]}. This returns citation metadata and clickable case refs; call courtlistener_get_cases only for matched cases that need full opinion text.',
            parameters: {
                type: "object",
                properties: {
                    citations: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            'Required list of clean reporter citations only. Put each reporter citation in its own array item, e.g. ["467 U.S. 837", "323 U.S. 134"]. Do not include case names. Up to 250 items.',
                    },
                },
                required: ["citations"],
            },
        },
    },
];
