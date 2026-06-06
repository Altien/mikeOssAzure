export type CourtlistenerToolEvent =
    | {
          type: "courtlistener_search_case_law";
          query: string;
          result_count: number;
          error?: string;
      }
    | {
          type: "courtlistener_get_cases";
          cluster_ids: number[];
          case_count: number;
          opinion_count: number;
          cases?: {
              cluster_id: number;
              case_name: string | null;
              citation: string | null;
              dateFiled?: string | null;
              url?: string | null;
          }[];
          error?: string;
      }
    | {
          type: "courtlistener_find_in_case";
          cluster_id: number | null;
          query: string;
          total_matches: number;
          case_name?: string | null;
          citation?: string | null;
          searches?: {
              cluster_id: number | null;
              query: string;
              total_matches: number;
              case_name?: string | null;
              citation?: string | null;
              error?: string;
          }[];
          error?: string;
      }
    | {
          type: "courtlistener_read_case";
          cluster_id: number | null;
          case_name?: string | null;
          citation?: string | null;
          opinion_count: number;
          error?: string;
      }
    | {
          type: "courtlistener_verify_citations";
          citation_count: number;
          match_count: number;
          error?: string;
      };

export type CaseCitationEvent = {
    type: "case_citation";
    cluster_id: number | null;
    case_name: string | null;
    citation: string | null;
    url: string;
    pdfUrl?: string | null;
    dateFiled?: string | null;
    judges?: string | null;
};

export const COURTLISTENER_TOOL_NAMES = {
    searchCaseLaw: "courtlistener_search_case_law",
    getCases: "courtlistener_get_cases",
    findInCase: "courtlistener_find_in_case",
    readCase: "courtlistener_read_case",
    verifyCitations: "courtlistener_verify_citations",
} as const;

export const COURTLISTENER_SYSTEM_PROMPT = `LEGAL RESEARCH QUERIES:
- When a user asks a question on US law, you are required to cite relevant case law in your answer. Always verify US case citations using the courtlistener_verify_citations tool.
- If the user gives case names or reporter citations, use courtlistener_verify_citations for those names/citations.
- CourtListener keyword/issue search is not available. Do not attempt to search CourtListener for new candidate cases by legal issue or keywords. Work only from cases/citations supplied by the user, cases found in the provided documents, or citations already present in the conversation.
- If any CourtListener tool call reports that a CourtListener rate limit was exceeded, or returns a 429/throttled/rate-limit error, do not make any further CourtListener API/search calls in that turn. Do not retry, verify more citations, fetch more cases, or run additional CourtListener searches; answer with the information already available and briefly state that CourtListener is rate limiting requests.
- For cases you may cite or materially rely on, follow this sequence: first use courtlistener_verify_citations for case names/citations, then use courtlistener_get_cases to fetch/cache the relevant case clusters, then use courtlistener_find_in_case to search targeted keywords in the cached opinions, and only if those keyword snippets are insufficient use courtlistener_read_case to read selected opinion text.
- Only cite cases whose underlying opinion text, or at least the specific relevant opinion passages, has been supplied to you in this turn. courtlistener_get_cases only fetches and caches opinions; it does NOT place full opinion text in your context. It returns text-free opinion metadata so you can choose which opinion(s) matter. After courtlistener_get_cases, use courtlistener_find_in_case for targeted keyword or phrase lookup inside that cached case. If those snippets are not enough, use courtlistener_read_case to read only the specific already-fetched opinion(s) you need. courtlistener_find_in_case and courtlistener_read_case require the case to have been fetched first.
- When a fetched case has multiple opinions, do not read all opinions by default. Choose the specific opinion_id or opinion_ids needed from the metadata or search hits. Prefer the lead/majority/controlling opinion when it is sufficient; read concurrences, dissents, or combined opinions only when they are necessary for the user's question.
- When using courtlistener_find_in_case, search for terms that are 1-3 words long and actually likely to appear exactly as written in the opinion text. Do not use long sentence-like phrases. Run courtlistener_find_in_case no more than 3 times in a single assistant turn; if those searches are insufficient, read the smallest needed opinion text with courtlistener_read_case or answer with the available information.
- Do not cite a case based only on memory, search-result snippets, reporter metadata, citationLinks, or verification results. Those sources may help choose candidates, but final case citations must be grounded in supplied opinion text/passages.
- Every case citation in final prose must be rendered as a clickable case-law panel link using the markdown link returned in citationLinks, e.g. [Case Name, Citation](us-case-12345). Do not write plain-text case citations without the link.
- Use numbered [N] markers for case citations in the final prose and include each cited case in the final <CITATIONS> block.
- Each case entry in the <CITATIONS> block must include quote(s) copied exactly from the supplied opinion text/passages for that case, e.g. {"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}. Do not include top-level "quote", "doc_id", "page", "case_name", or "citation" for case entries.
- If a case is useful but you do not have its opinion text or relevant passages, either fetch the opinions before citing it or say that you could not read the opinion and do not cite or characterize the case beyond basic metadata.`;

export const COURTLISTENER_TOOLS = [
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.getCases,
            description:
                "Fetch and cache one or more CourtListener case clusters and their opinions by cluster ID. This returns metadata/counts only, not full opinion text. After this, call courtlistener_find_in_case for targeted passages or courtlistener_read_case if broader full-case context is needed.",
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
                "Verify legal case citations using CourtListener's citation lookup. Accepts raw text containing citations, or multiple citation strings. This returns citation metadata and clickable case refs; call courtlistener_get_cases only for matched cases that need full opinion text.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description:
                            "Raw text containing one or more legal citations. Max 64,000 characters sent to CourtListener.",
                    },
                    citations: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional list of citation strings. Up to 250 will be joined into the request text field.",
                    },
                },
            },
        },
    },
];
