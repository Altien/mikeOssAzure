import type { WebSource, WebToolEvent } from "@mike/contracts";
import type { ProviderWebSearchEvent } from "../../../../lib/llm";
import { allowWebPage, webToolError, type WebTurnState } from "./webSearchTools";

export const PROVIDER_MAX_SEARCHES = 5;

export function createProviderWebSearchTracker(state: WebTurnState) {
    const cited = new Map<string, WebSource>();
    return {
        handle(event: ProviderWebSearchEvent): {
            frame?: { type: "web_search_start"; search_id: string; query?: string };
            event?: WebToolEvent;
        } {
            switch (event.kind) {
                case "search_started":
                    return {
                        frame: {
                            type: "web_search_start",
                            search_id: event.id,
                            ...(event.query ? { query: event.query } : {}),
                        },
                    };
                case "search_finished":
                    for (const result of event.results) allowWebPage(state, result.url);
                    return {
                        event: {
                            type: "web_search",
                            search_id: event.id,
                            query: event.query ?? "",
                            results: event.results,
                            ...(event.failed ? webToolError("failed") : {}),
                        },
                    };
                case "cited_source":
                    allowWebPage(state, event.source.url);
                    if (!cited.has(event.source.url)) {
                        cited.set(event.source.url, event.source);
                    }
                    return {};
                case "unavailable":
                    return {
                        event: {
                            type: "web_search",
                            search_id: "provider-unavailable",
                            query: "",
                            results: [],
                            ...webToolError("unavailable"),
                        },
                    };
            }
        },
        citedSources(): WebToolEvent | null {
            return cited.size
                ? { type: "web_sources", sources: [...cited.values()] }
                : null;
        },
    };
}
