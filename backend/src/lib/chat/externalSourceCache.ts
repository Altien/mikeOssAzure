import { createHash } from "node:crypto";
import { completeText, type UserApiKeys } from "../llm";

export type ExternalSourceDocument = {
  id: string;
  provider: string;
  externalId: string;
  versionId: string;
  title: string;
  text: string;
  originUrl?: string;
  searchTool: string;
  readTool: string;
};

export type ExternalSourceSummary = {
  text: string;
  status: "generated" | "fallback";
  model: string | null;
};

export type CachedExternalSource = {
  source: ExternalSourceDocument;
  contentHash: string;
  summary: ExternalSourceSummary | null;
};

export type ExternalSourceSummarizer = (
  source: ExternalSourceDocument,
) => Promise<string>;

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function accessGuidance(source: ExternalSourceDocument): string {
  return `The complete source text is cached server-side. Use ${source.searchTool} to search it and ${source.readTool} to read the relevant text. Treat this summary as orientation only, not as source evidence.`;
}

function fallbackSummary(source: ExternalSourceDocument): string {
  return `${source.title} was downloaded from ${source.provider} and contains ${source.text.length.toLocaleString("en-US")} characters. An automatic content summary was unavailable.`;
}

function normalizeSummary(
  source: ExternalSourceDocument,
  summary: string,
): string {
  const body = summary.trim() || fallbackSummary(source);
  return `${body}\n\n${accessGuidance(source)}`;
}

export class ExternalSourceCache {
  private readonly entries = new Map<string, CachedExternalSource>();
  private readonly inFlightSummaries = new Map<
    string,
    Promise<ExternalSourceSummary>
  >();

  constructor(
    private readonly options: {
      summarizer?: ExternalSourceSummarizer;
      summaryModel?: string;
    } = {},
  ) {}

  get(id: string): CachedExternalSource | undefined {
    return this.entries.get(id);
  }

  values(): CachedExternalSource[] {
    return Array.from(this.entries.values());
  }

  async cache(source: ExternalSourceDocument): Promise<CachedExternalSource> {
    const hash = contentHash(source.text);
    const current = this.entries.get(source.id);
    if (current?.contentHash === hash && current.summary) return current;

    // Cache the complete source before starting the optional LLM work. Search,
    // read and verification remain available even if summary generation fails.
    const pendingEntry: CachedExternalSource = {
      source,
      contentHash: hash,
      summary: null,
    };
    this.entries.set(source.id, pendingEntry);

    const summaryKey = `${source.id}:${hash}`;
    let summaryPromise = this.inFlightSummaries.get(summaryKey);
    if (!summaryPromise) {
      summaryPromise = this.generateSummary(source).finally(() => {
        this.inFlightSummaries.delete(summaryKey);
      });
      this.inFlightSummaries.set(summaryKey, summaryPromise);
    }

    const summary = await summaryPromise;
    const latest = this.entries.get(source.id);
    if (latest?.contentHash !== hash) return latest ?? pendingEntry;

    const completed = { ...latest, summary };
    this.entries.set(source.id, completed);
    return completed;
  }

  private async generateSummary(
    source: ExternalSourceDocument,
  ): Promise<ExternalSourceSummary> {
    if (!this.options.summarizer) {
      return {
        text: normalizeSummary(source, fallbackSummary(source)),
        status: "fallback",
        model: null,
      };
    }

    try {
      const generated = await this.options.summarizer(source);
      return {
        text: normalizeSummary(source, generated),
        status: generated.trim() ? "generated" : "fallback",
        model: this.options.summaryModel ?? null,
      };
    } catch {
      return {
        text: normalizeSummary(source, fallbackSummary(source)),
        status: "fallback",
        model: this.options.summaryModel ?? null,
      };
    }
  }
}

export function createFastModelExternalSourceSummarizer(args: {
  model: string;
  apiKeys?: UserApiKeys;
}): ExternalSourceSummarizer {
  return async (source) =>
    completeText({
      model: args.model,
      apiKeys: args.apiKeys,
      maxTokens: 400,
      systemPrompt:
        "Summarize a downloaded external source for an AI agent's orientation. Identify the document's subject, structure, major issues, and where likely-relevant material appears. Be concise and neutral. Do not present the summary as evidence, do not invent details, and do not give instructions about tools.",
      user: `Title: ${source.title}\nProvider: ${source.provider}\n\nSOURCE TEXT:\n${source.text}`,
    });
}
