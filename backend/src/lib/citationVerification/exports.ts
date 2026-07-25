import type {
  AuthorityTraceWorkspace,
  CitationVerificationReview,
} from "./reviewService";

export const MAX_EMBEDDED_ORIGINAL_BYTES = 5 * 1024 * 1024;
export const MAX_EMBEDDED_ORIGINALS_TOTAL_BYTES = 15 * 1024 * 1024;

export type OriginalCandidate = {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
};

type OriginalManifestEntry = {
  filename: string;
  status: "embedded" | "skipped";
  reason?: "file_too_large" | "total_limit";
  bytes: number;
  data?: string;
  mediaType?: string;
};

export function selectOriginalsForEmbedding(
  candidates: OriginalCandidate[],
): OriginalManifestEntry[] {
  let total = 0;
  return candidates.map((candidate) => {
    if (candidate.bytes.byteLength > MAX_EMBEDDED_ORIGINAL_BYTES) {
      return {
        filename: candidate.filename,
        status: "skipped",
        reason: "file_too_large",
        bytes: candidate.bytes.byteLength,
      };
    }
    if (
      total + candidate.bytes.byteLength >
      MAX_EMBEDDED_ORIGINALS_TOTAL_BYTES
    ) {
      return {
        filename: candidate.filename,
        status: "skipped",
        reason: "total_limit",
        bytes: candidate.bytes.byteLength,
      };
    }
    total += candidate.bytes.byteLength;
    return {
      filename: candidate.filename,
      status: "embedded",
      bytes: candidate.bytes.byteLength,
      mediaType: candidate.mediaType,
      data: Buffer.from(candidate.bytes).toString("base64"),
    };
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function citationState(
  citation: AuthorityTraceWorkspace["verified_record"]["citations"][number],
): string {
  if (citation.status === "no_quote_claimed") return "No quote claimed";
  if (citation.status === "anchor_failed") {
    return citation.failure_reason === "source_missing"
      ? "Source missing"
      : "Failed";
  }
  return citation.memo_anchor?.match !== "exact" ||
    citation.anchors.some((anchor) => anchor.match !== "exact")
    ? "Formatting differs"
    : "Exact";
}

function renderSegments(
  segments: AuthorityTraceWorkspace["memo"]["segments"],
): string {
  return segments
    .map((segment) => {
      const text = escapeHtml(segment.text);
      return segment.highlights.length
        ? `<mark data-citations="${escapeHtml(segment.highlights.join(" "))}">${text}</mark>`
        : text;
    })
    .join("");
}

function renderReview(review: CitationVerificationReview | undefined): string {
  if (!review) return "Unreviewed";
  return `${escapeHtml(review.verdict.replaceAll("_", " "))}${
    review.note ? ` — ${escapeHtml(review.note)}` : ""
  }`;
}

function renderIntegrity(workspace: AuthorityTraceWorkspace): string {
  if (workspace.integrity.ok) {
    return '<div class="integrity ok">Integrity revalidated at export time.</div>';
  }
  return `<div class="integrity degraded"><strong>DEGRADED EXPORT — integrity checks failed.</strong><ul>${workspace.integrity.warnings
    .map((warning) => `<li>${escapeHtml(warning.message)}</li>`)
    .join("")}</ul></div>`;
}

function originalManifest(args: {
  requested?: boolean;
  originals?: OriginalCandidate[];
}): { entries: OriginalManifestEntry[]; note: string } {
  if (!args.requested) {
    return { entries: [], note: "Original binaries were not requested." };
  }
  const entries = selectOriginalsForEmbedding(args.originals ?? []);
  return {
    entries,
    note: entries.length
      ? "Original binary embedding was evaluated against 5 MiB per-file and 15 MiB total caps."
      : "Original binaries were requested but are not available from the text-only export workspace.",
  };
}

function documentShell(args: {
  title: string;
  landscape?: boolean;
  body: string;
  workspace: AuthorityTraceWorkspace;
  originalsRequested?: boolean;
  originals?: OriginalCandidate[];
}): string {
  const manifest = originalManifest(args);
  const embedded = safeEmbeddedJson({
    workspace: args.workspace,
    originals: {
      note: manifest.note,
      entries: manifest.entries,
      limits: {
        per_file_bytes: MAX_EMBEDDED_ORIGINAL_BYTES,
        total_bytes: MAX_EMBEDDED_ORIGINALS_TOTAL_BYTES,
      },
    },
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(args.title)}</title>
<style>
@page { size: letter${args.landscape ? " landscape" : ""}; margin: 0.45in; }
* { box-sizing: border-box; } body { margin: 0; color: #172033; font: 14px/1.45 system-ui, sans-serif; }
header { border-bottom: 2px solid #172033; margin-bottom: 16px; padding-bottom: 10px; }
h1 { font-size: 22px; margin: 0; } h2 { font-size: 15px; margin: 18px 0 8px; }
.integrity { border: 1px solid; margin: 12px 0; padding: 10px; } .ok { background:#ecfdf5; border-color:#6ee7b7; }
.degraded { background:#fef2f2; border-color:#f87171; color:#991b1b; }
table { border-collapse: collapse; width: 100%; } th, td { border:1px solid #cbd5e1; padding:6px; text-align:left; vertical-align:top; }
th { background:#f1f5f9; } .text { border:1px solid #cbd5e1; padding:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
mark { background:#fde68a; } .muted { color:#64748b; font-size:12px; } footer { border-top:1px solid #94a3b8; margin-top:18px; padding-top:8px; }
@media print { .no-print { display:none; } tr { break-inside:avoid; } }
</style>
</head>
<body>
${args.body}
<footer><strong>Integrity:</strong> ${workspaceIntegritySummary(args.workspace)}<br><span class="muted">${escapeHtml(manifest.note)}</span></footer>
<script type="application/json" id="authority-trace-data">${embedded}</script>
</body>
</html>`;
}

function workspaceIntegritySummary(workspace: AuthorityTraceWorkspace): string {
  return workspace.integrity.ok
    ? "all memo and source hashes matched"
    : `${workspace.integrity.warnings.length} changed or missing input(s); affected highlights suppressed`;
}

export function buildReviewHtml(
  workspace: AuthorityTraceWorkspace,
  options: {
    originalsRequested?: boolean;
    originals?: OriginalCandidate[];
  } = {},
): string {
  const rows = workspace.verified_record.citations
    .map((citation) => {
      const stale = workspace.reviews.filter(
        (review) => review.citation_id === citation.id && review.stale,
      );
      return `<tr><td>${escapeHtml(citation.id)}</td><td>${escapeHtml(citation.cite_text)}</td><td>${escapeHtml(citationState(citation))}</td><td>${escapeHtml(citation.proposition)}</td><td>${renderReview(workspace.current_reviews[citation.id])}</td><td>${stale.length}</td></tr>`;
    })
    .join("");
  const sources = Object.entries(workspace.sources)
    .map(
      ([key, source]) =>
        `<h2>${escapeHtml(key)} — ${escapeHtml(source.title)}</h2><div class="text">${renderSegments(source.segments)}</div>`,
    )
    .join("");
  return documentShell({
    title: "Authority Trace offline review",
    workspace,
    originalsRequested: options.originalsRequested,
    originals: options.originals,
    body: `<header><h1>Authority Trace offline review</h1><div class="muted">Run ${escapeHtml(workspace.id)} · ${escapeHtml(workspace.created_at)}</div></header>
${renderIntegrity(workspace)}
<table><thead><tr><th>ID</th><th>Citation</th><th>Anchor state</th><th>Proposition</th><th>Current verdict</th><th>Stale reviews</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Memo — ${escapeHtml(workspace.memo.filename)}</h2><div class="text">${renderSegments(workspace.memo.segments)}</div>
${sources}`,
  });
}

export function buildAuditHtml(
  workspace: AuthorityTraceWorkspace,
  options: {
    originalsRequested?: boolean;
    originals?: OriginalCandidate[];
  } = {},
): string {
  const rows = workspace.verified_record.citations
    .map((citation) => {
      const stale = workspace.reviews.filter(
        (review) => review.citation_id === citation.id && review.stale,
      );
      return `<tr><td>${escapeHtml(citation.id)}</td><td>${escapeHtml(citation.cite_text)}</td><td>${escapeHtml(citationState(citation))}</td><td>${renderReview(workspace.current_reviews[citation.id])}</td><td>${stale.map((review) => escapeHtml(review.verdict.replaceAll("_", " "))).join(", ") || "—"}</td><td>${escapeHtml(citation.binds_to)}</td></tr>`;
    })
    .join("");
  return documentShell({
    title: "Authority Trace audit record",
    landscape: true,
    workspace,
    originalsRequested: options.originalsRequested,
    originals: options.originals,
    body: `<header><h1>Authority Trace audit record</h1><div class="muted">Run ${escapeHtml(workspace.id)} · ${escapeHtml(workspace.created_at)}</div></header>
${renderIntegrity(workspace)}
<table><thead><tr><th>ID</th><th>Citation</th><th>Anchor state</th><th>Current verdict</th><th>Stale verdicts</th><th>Binding hash</th></tr></thead><tbody>${rows}</tbody></table>`,
  });
}
