export const IRONCLAD_TOOL_NAMES = {
    searchContracts: "ironclad_search_contracts",
    getContract: "ironclad_get_contract",
    importContract: "ironclad_import_contract",
} as const;

export type IroncladToolEvent =
    | {
          type: "ironclad_search_contracts";
          query: string;
          result_count: number;
          error?: string;
      }
    | {
          type: "ironclad_get_contract";
          record_id: string | null;
          name?: string | null;
          attachment_count: number;
          error?: string;
      }
    | {
          type: "ironclad_import_contract";
          record_id: string;
          attachment_key: string;
          filename?: string;
          error?: string;
      };

export const IRONCLAD_SYSTEM_PROMPT = `IRONCLAD CONTRACTS:
This instance is connected to an Ironclad CLM account. Use the Ironclad tools when the user asks about contracts that may live in Ironclad rather than in Mike documents.

Workflow:
1. Find candidate records with ironclad_search_contracts (keyword search across record properties).
2. Inspect a record's metadata and available attachments with ironclad_get_contract.
3. To analyze a contract's contents in Mike, import it with ironclad_import_contract. Choose the attachment the user wants (default "signedCopy" for executed agreements). The import creates a Mike document you can immediately read with read_document / fetch_documents using the returned doc_id.
- Do not claim a contract was imported unless ironclad_import_contract returned a document. If Ironclad returns an error, report it and stop using Ironclad tools for that turn.`;

export const IRONCLAD_TOOLS = [
    {
        type: "function",
        function: {
            name: IRONCLAD_TOOL_NAMES.searchContracts,
            description:
                "Search the connected Ironclad CLM account for contract records by keyword (matches the Ironclad in-app search across record properties). Returns record IDs, names, types, counterparties, and agreement dates. Use ironclad_get_contract for details and attachments.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Free-text search, e.g. a counterparty name or contract subject.",
                    },
                    limit: {
                        type: "integer",
                        description:
                            "Maximum number of records to return. Default 10, max 25.",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: IRONCLAD_TOOL_NAMES.getContract,
            description:
                "Retrieve a single Ironclad contract record: metadata plus the list of available attachment keys (e.g. signedCopy) that can be imported with ironclad_import_contract.",
            parameters: {
                type: "object",
                properties: {
                    recordId: {
                        type: "string",
                        description:
                            "Ironclad record ID from ironclad_search_contracts.",
                    },
                },
                required: ["recordId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: IRONCLAD_TOOL_NAMES.importContract,
            description:
                "Download an attachment from an Ironclad record and import it as a Mike document (into the current project when chatting in a project, otherwise as a standalone document). Returns a doc_id handle you can immediately read with read_document / fetch_documents, plus a download card for the user. Call ironclad_get_contract first to choose the right attachmentKey.",
            parameters: {
                type: "object",
                properties: {
                    recordId: {
                        type: "string",
                        description: "Ironclad record ID to import from.",
                    },
                    attachmentKey: {
                        type: "string",
                        description:
                            "Attachment key on the record. Default \"signedCopy\" (the executed agreement).",
                    },
                },
                required: ["recordId"],
            },
        },
    },
];
