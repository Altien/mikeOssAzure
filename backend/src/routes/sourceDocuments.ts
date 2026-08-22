import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCourtlistenerCaseOpinions } from "../lib/courtlistener";
import { createServerSupabase } from "../lib/supabase";
import { getUserModelSettings } from "../lib/userSettings";
import { caseClusterId, normalizeCaseDocument } from "../lib/sourceDocuments";
import { sendInternalError } from "../lib/httpError";

export const sourceDocumentsRouter = Router();

sourceDocumentsRouter.use(requireAuth);

const documentFetches = new Map<string, Promise<unknown>>();

// Hydrate opaque source-document IDs that need provider-backed content. File
// documents use the existing single-document viewer endpoints; `case:*` is the
// first provider implemented behind this normalized contract.
sourceDocumentsRouter.get("/:documentId", async (req, res) => {
  const documentId = String(req.params.documentId ?? "");
  const clusterId = caseClusterId(documentId);
  if (!clusterId) {
    return res.status(404).json({ detail: "Document not found" });
  }

  try {
    const userId = String(res.locals.userId ?? "");
    const settings = await getUserModelSettings(userId);
    const fetchKey = `${userId}:${documentId}`;
    let request = documentFetches.get(fetchKey);
    if (!request) {
      request = getCourtlistenerCaseOpinions({
        clusterId,
        db: createServerSupabase(),
        includeFullText: true,
        maxChars: 50000,
        apiToken: settings.api_keys.courtlistener,
      }).finally(() => documentFetches.delete(fetchKey));
      documentFetches.set(fetchKey, request);
    }

    const fetched = await request;
    const value =
      fetched && typeof fetched === "object" && !Array.isArray(fetched)
        ? (fetched as Record<string, unknown>)
        : {};
    return res.json(
      normalizeCaseDocument({
        clusterId,
        caseName:
          typeof value.caseName === "string" ? value.caseName : undefined,
        citations: Array.isArray(value.citations)
          ? value.citations.filter(
              (citation): citation is string => typeof citation === "string",
            )
          : undefined,
        dateFiled:
          typeof value.dateFiled === "string" ? value.dateFiled : undefined,
        url: typeof value.url === "string" ? value.url : undefined,
        pdfUrl: typeof value.pdfUrl === "string" ? value.pdfUrl : undefined,
        opinions: Array.isArray(value.opinions) ? value.opinions : [],
      }),
    );
  } catch (error) {
    return sendInternalError(res, error, 502);
  }
});
