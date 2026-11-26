// Fixed-name tenant infrastructure metrics. Every failure is counted even when
// the accompanying diagnostic log is throttled. No credentials or user IDs.
type Metric = { name: string; value: number; properties?: Record<string, string> };
type MetricClient = { trackMetric(metric: Metric): void };
const counts = new Map<string, number>();
let client: Promise<MetricClient | undefined> | undefined;
export function recordTenantMetric(name: string, properties?: Record<string, string>): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return;
  client ??= import("applicationinsights").then((mod) => {
    const sdk = mod as unknown as { defaultClient?: MetricClient; default?: { defaultClient?: MetricClient } };
    return sdk.defaultClient ?? sdk.default?.defaultClient;
  }).catch(() => undefined);
  void client.then((telemetry) => telemetry?.trackMetric({ name, value: 1, properties })).catch(() => {});
}
export function tenantMetricCount(name: string): number { return counts.get(name) ?? 0; }
