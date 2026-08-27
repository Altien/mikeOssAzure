export const TRADEMARK_PREFIX_MONITOR_PRESET = {
  id: "trademark-prefix-watch",
  name: "Trademark Prefix Watch",
  description:
    "Daily USPTO watch for newly registered federal marks beginning with a word or phrase.",
  requiredToolName: "tm_search_trademarks",
  monitor: {
    name: "Trademark Prefix Watch",
    topic: [
      "Review newly registered U.S. federal trademarks returned by the configured USPTO connector.",
      "Identify likely conflicts, relevant owners and classes, and facts requiring counsel review.",
      "Do not infer similarity, legal status, or likelihood of confusion beyond the source records.",
    ].join("\n\n"),
    jurisdiction: "United States federal trademarks",
    sourceTypes: [] as const,
    connectorConfig: {
      mode: "trademark_prefix" as const,
      prefix: "",
      status: "live" as const,
      internationalClass: null,
    },
    intervalHours: 24,
    lookbackDays: 14,
    maxItemsPerRun: 50,
  },
  sources: [],
};
