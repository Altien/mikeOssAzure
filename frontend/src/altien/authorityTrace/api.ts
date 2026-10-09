import { bounceIfUnauthorized } from "@/app/lib/auth-token";
import {
  API_BASE,
  MikeApiError,
  apiRequest,
  getAuthHeader,
} from "@/app/lib/mikeApi";

export type AuthorityTraceVerdict =
  | "verified"
  | "needs_attention"
  | "rejected";

export type AuthorityTraceSegment = {
  text: string;
  highlights: string[];
};

export type AuthorityTraceReview = {
  id: string;
  run_id: string;
  citation_id: string;
  binds_to: string;
  verdict: AuthorityTraceVerdict;
  note: string | null;
  reviewer_user_id: string;
  reviewer_email: string | null;
  created_at: string;
  stale: boolean;
};

export type AuthorityTraceCitation = {
  id: string;
  source_candidates: string[];
  cite_text: string;
  proposition: string;
  support_type: "quotation" | "paraphrase";
  status: "anchored" | "no_quote_claimed" | "anchor_failed";
  failure_reason?: string;
  binds_to: string;
  warnings: string[];
  memo_anchor: {
    start: number;
    end: number;
    quote: string;
    match: "exact" | "normalized" | "hyphenless";
    warnings: string[];
  } | null;
  anchors: Array<{
    source: string;
    quote: string;
    start: number;
    end: number;
    match: "exact" | "normalized" | "hyphenless";
    warnings: string[];
  }>;
};

export type AuthorityTraceWorkspace = {
  id: string;
  project_id: string;
  created_at: string;
  verified_record: {
    citations: AuthorityTraceCitation[];
  };
  report: {
    outcome: "success" | "completed_with_failures";
    total: number;
    anchored: number;
    failed: number;
    no_quote_claimed: number;
    exact: number;
    formatting_different: number;
  };
  memo: {
    document_id: string;
    version_id: string;
    filename: string;
    available: boolean;
    integrity: "ok" | "changed" | "missing";
    segments: AuthorityTraceSegment[];
  };
  sources: Record<
    string,
    {
      document_id: string;
      version_id: string;
      filename: string;
      title: string;
      kind: string;
      available: boolean;
      integrity: "ok" | "changed" | "missing";
      segments: AuthorityTraceSegment[];
    }
  >;
  reviews: AuthorityTraceReview[];
  current_reviews: Record<string, AuthorityTraceReview>;
  integrity: {
    ok: boolean;
    warnings: Array<{
      scope: "memo" | "source";
      source?: string;
      status: "changed" | "missing";
      message: string;
    }>;
  };
};

export async function getAuthorityTraceRun(
  runId: string,
): Promise<AuthorityTraceWorkspace> {
  return apiRequest<AuthorityTraceWorkspace>(
    `/authority-trace/runs/${encodeURIComponent(runId)}`,
  );
}

export async function saveAuthorityTraceReview(
  runId: string,
  payload: {
    citation_id: string;
    binds_to: string;
    verdict: AuthorityTraceVerdict;
    note?: string | null;
  },
): Promise<AuthorityTraceReview> {
  return apiRequest<AuthorityTraceReview>(
    `/authority-trace/runs/${encodeURIComponent(runId)}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function downloadAuthorityTraceExport(
  runId: string,
  kind: "review" | "audit",
  options: { forceDegraded?: boolean } = {},
): Promise<void> {
  const authHeaders = await getAuthHeader();
  const query = options.forceDegraded ? "?force_degraded=true" : "";
  const response = await fetch(
    `${API_BASE}/authority-trace/runs/${encodeURIComponent(runId)}/${kind}.html${query}`,
    { headers: authHeaders, credentials: "include" },
  );
  bounceIfUnauthorized(response);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new MikeApiError({
      message: payload?.detail ?? `Export failed: ${response.status}`,
      status: response.status,
    });
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `authority-trace-${runId}-${kind}.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
