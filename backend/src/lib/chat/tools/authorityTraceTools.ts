export const AUTHORITY_TRACE_TOOL_NAMES = {
  extractDocument: "extract_document_for_verification",
  readVerificationSource: "read_verification_source",
  verifyCitationSources: "verify_citation_sources",
} as const;

export type AuthorityTraceEvent =
  | {
      type: "authority_trace_extraction";
      outcome: "success" | "fatal";
      document_id?: string;
      version_id?: string;
      document_handle?: string;
      filename?: string;
      page_count?: number | null;
      warnings?: string[];
      error?: string;
    }
  | {
      type: "authority_trace_verification";
      run_id?: string;
      outcome: "success" | "completed_with_failures" | "fatal";
      total: number;
      anchored: number;
      failed: number;
      exact?: number;
      formatting_different?: number;
      no_quote_claimed?: number;
      warning_count?: number;
      diagnostics?: string[];
      error?: string;
    };

export const AUTHORITY_TRACE_SYSTEM_PROMPT = `AUTHORITY TRACE SOURCE SELECTION:
Citation verification is a hybrid task. You are responsible for discovering candidate authorities, comparing plausible sources, deciding which documents and passages may support each citation, and explaining uncertainty. Choose whichever available project-document, legal-research, search, read, retrieval, or download tools are appropriate for that work; do not assume one fixed provider or search path.

Backend research/read results that supply canonical source text may include a verification_source_id. A search result, snippet, summary, or generated analysis without that id is discovery evidence only and cannot be used as a verification source. Before using a verification_source_id, call read_verification_source and copy proposed passages from the exact verification text it returns. Before calling verify_citation_sources, every selected source must be either an authorized project document or a trusted verification_source_id returned by a backend tool in this turn, and must be included in the sources map. Never invent a document id or verification source id. Include all plausible source keys in source_candidates, and bind every proposed exact quote to the source key it came from. The TypeScript verifier will resolve the trusted backend source, confirm exact textual presence, calculate offsets and hashes, and persist the result. It does not replace your judgment about source selection, legal validity, or whether the passage substantively supports the proposition.

When a selected project source is DOCX or PDF, call extract_document_for_verification before proposing passages. Use the returned document_handle as the verification source. The extraction is a stable Markdown snapshot; an ocr_required warning means the PDF text layer is inadequate and no OCR content was invented.

After verify_citation_sources returns, always give the user a final synthesis. Name formatting-different matches, citations with no proposed quote, every warning, every memo-citation failure, every source-passage failure, and any fatal source/version error.`;

export const AUTHORITY_TRACE_TOOLS = [
  {
    type: "function",
    function: {
      name: AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
      description:
        "Create a stable, immutable Markdown verification record from an accessible project DOCX or text-layer PDF. Preserves DOCX headings, tables, footnotes and endnotes; adds printed-page markers to PDF text; reports revisions or OCR requirements without inventing text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: {
            type: "string",
            description:
              "Project document handle or id, such as doc-0.",
          },
          version_id: {
            type: "string",
            description:
              "Optional source version id. Omit to snapshot the active version.",
          },
          first_page: {
            type: "integer",
            minimum: 1,
            description:
              "Printed page number for the first PDF page. Defaults to 1 and is ignored for DOCX.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: AUTHORITY_TRACE_TOOL_NAMES.readVerificationSource,
      description:
        "Read the exact, backend-registered verification text for a verification_source_id returned by a research, retrieval, read, or download tool in this turn. Copy proposed quotes from this text before calling verify_citation_sources.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          verification_source_id: {
            type: "string",
            description:
              "The server-issued verification_source_id returned by another tool in this turn.",
          },
        },
        required: ["verification_source_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
      description:
        "Mechanically verify proposed citation passages against project source documents. Use after reading the memo and sources and copying the exact passages that should support each citation. Returns a persisted verification run with anchored and failed counts. This checks textual presence only; it does not decide whether a source is valid or a proposition is correct.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema_version: {
            type: "integer",
            enum: [1],
          },
          memo: {
            type: "object",
            additionalProperties: false,
            properties: {
              document_id: {
                type: "string",
                description:
                  "Project document handle or id for the memo, such as doc-0.",
              },
              version_id: {
                type: "string",
                description:
                  "Optional document version id. Omit to snapshot the active version.",
              },
              label: { type: "string" },
            },
            required: ["document_id"],
          },
          sources: {
            type: "object",
            description:
              "Source descriptors keyed by a short stable name used by citations.",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                document_id: {
                  type: "string",
                  description:
                    "Project document handle/id (such as doc-1), or a trusted verification_source_id returned by a research/read tool in this turn.",
                },
                version_id: {
                  type: "string",
                  description:
                    "Optional document version id. Omit to snapshot the active version.",
                },
                title: { type: "string" },
                kind: {
                  type: "string",
                  enum: [
                    "case",
                    "statute",
                    "brief",
                    "evidence",
                    "secondary",
                    "other",
                  ],
                },
              },
              required: ["document_id", "title", "kind"],
            },
          },
          citations: {
            type: "array",
            minItems: 1,
            maxItems: 250,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  description: "Unique run-local id such as c001.",
                },
                source_candidates: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  uniqueItems: true,
                  items: { type: "string" },
                  description:
                    "Keys for all plausible candidate authorities considered for this citation.",
                },
                cite_text: {
                  type: "string",
                  description:
                    "The citation text exactly as it appears in the memo.",
                },
                memo_context: {
                  type: "string",
                  description:
                    "Surrounding memo text that uniquely identifies this occurrence when cite_text appears more than once.",
                },
                pin: {
                  type: "string",
                  description:
                    "Optional source locator supplied with the citation.",
                },
                proposition: {
                  type: "string",
                  description:
                    "The claim this citation is offered to support.",
                },
                support_type: {
                  type: "string",
                  enum: ["quotation", "paraphrase"],
                },
                anchors_proposed: {
                  type: "array",
                  minItems: 0,
                  maxItems: 3,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      source: {
                        type: "string",
                        description:
                          "The sources object key for the document containing this passage.",
                      },
                      quote: {
                        type: "string",
                        description:
                          "An exact passage copied from that source document.",
                      },
                    },
                    required: ["source", "quote"],
                  },
                  description:
                    "Passages copied from source documents and bound to their source keys. Use an empty array only when the citation claims no supporting quote.",
                },
              },
              required: [
                "id",
                "source_candidates",
                "cite_text",
                "proposition",
                "support_type",
                "anchors_proposed",
              ],
            },
          },
        },
        required: ["schema_version", "memo", "sources", "citations"],
      },
    },
  },
];
