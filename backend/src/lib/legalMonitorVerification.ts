import type { LegalMonitorDevelopment } from "./legalMonitors";

/**
 * Deterministic reconciliation of a model's claimed developments against the
 * material actually fetched this run.
 *
 * The analysis prompt tells the model never to invent a URL, citation or date.
 * That is an instruction, and instructions are not a control. This pass is the
 * control: it checks the two claims that can be checked mechanically — the
 * link and the citation — against the fetched source items, and marks anything
 * it cannot reconcile.
 *
 * It deliberately does not call a model. A verification step that itself
 * hallucinates is not a verification step.
 */

export type VerifiableSourceItem = {
  url: string | null;
  title: string;
  summary: string;
  content: string;
};

export const UNVERIFIED_URL = "url not found in fetched sources";
export const UNVERIFIED_CITATION = "citation not found in fetched sources";

/**
 * Compare hosts and paths, ignoring the parts that legitimately drift between
 * a feed entry and the page it points at: scheme, `www.`, trailing slash,
 * tracking parameters, and fragments.
 */
export function canonicalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.host.replace(/^www\./i, "").toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  return `${host}${path}`;
}

/**
 * Citations are compared on alphanumerics only, so spacing and punctuation
 * differences ("17 C.F.R. § 240.10b-5" vs "17 CFR 240.10b5") do not read as a
 * fabrication. Case is ignored.
 */
export function citationFingerprint(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Citations shorter than this match too much text to be evidence of anything. */
const MIN_CITATION_FINGERPRINT = 4;

export function buildVerificationIndex(items: VerifiableSourceItem[]): {
  urls: Set<string>;
  corpus: string;
} {
  const urls = new Set<string>();
  const parts: string[] = [];
  for (const item of items) {
    if (item.url) {
      const canonical = canonicalizeUrl(item.url);
      if (canonical) urls.add(canonical);
    }
    parts.push(item.title, item.summary, item.content);
  }
  return { urls, corpus: citationFingerprint(parts.join(" ")) };
}

/**
 * Returns the developments with `unverified` populated. Nothing is dropped:
 * an unreconciled development is still shown, marked, because a source that
 * changed between fetch and analysis is a real and innocent cause. Deciding
 * what to do with the mark is the caller's job.
 */
export function verifyDevelopments(
  developments: LegalMonitorDevelopment[],
  items: VerifiableSourceItem[],
): LegalMonitorDevelopment[] {
  const { urls, corpus } = buildVerificationIndex(items);

  return developments.map((development) => {
    const unverified: string[] = [];

    if (development.url) {
      const canonical = canonicalizeUrl(development.url);
      // An unparseable URL cannot be matched, so it cannot be trusted either.
      if (!canonical || !urls.has(canonical)) unverified.push(UNVERIFIED_URL);
    }

    if (development.citation) {
      const fingerprint = citationFingerprint(development.citation);
      if (
        fingerprint.length >= MIN_CITATION_FINGERPRINT &&
        !corpus.includes(fingerprint)
      ) {
        unverified.push(UNVERIFIED_CITATION);
      }
    }

    return unverified.length ? { ...development, unverified } : development;
  });
}

export function countUnverified(
  developments: LegalMonitorDevelopment[],
): number {
  return developments.filter((development) => development.unverified.length)
    .length;
}
