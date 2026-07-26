import { downloadFile } from "../../../lib/storage";
import { createServerSupabase } from "../../../lib/supabase";
import type { DocIndex } from "../../../lib/chat/types";
import {
  verificationReportSchema,
  verificationProposalSchema,
  verifiedRecordSchema,
  type VerificationProposal,
  type VerificationReport,
  type VerifiedRecord,
} from "./schemas";
import {
  verifyResolvedProposal,
  type ResolvedDocument,
} from "./verify";

type Db = ReturnType<typeof createServerSupabase>;

type DocumentRow = {
  id: string;
  project_id: string | null;
  current_version_id: string | null;
  status: string;
};

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  filename: string | null;
  file_type: string | null;
};

export type CitationVerificationRunRow = {
  id: string;
  project_id: string;
  verified_record: VerifiedRecord;
  report: VerificationReport;
  created_at: string;
};

export type VerificationArtifact = {
  artifactId: string;
  provider: string;
  externalId: string;
  versionId: string;
  filename: string;
  text: string;
  originUrl?: string;
};

export type VerificationArtifactStore = Map<string, VerificationArtifact>;

export class VerificationExtractionRequiredError extends Error {
  readonly code = "verification_extraction_required";

  constructor(
    readonly documentId: string,
    readonly versionId: string,
  ) {
    super(
      `Document ${documentId}/${versionId} must be converted with extract_document_for_verification before citation verification`,
    );
    this.name = "VerificationExtractionRequiredError";
  }
}

export function registerVerificationArtifact(
  store: VerificationArtifactStore,
  artifact: VerificationArtifact,
): string {
  store.set(artifact.artifactId, artifact);
  return artifact.artifactId;
}

function resolveDocumentId(
  rawId: string,
  docIndex: DocIndex,
  artifacts: VerificationArtifactStore,
): string {
  if (artifacts.has(rawId)) return rawId;
  const direct = docIndex[rawId]?.document_id;
  if (direct) return direct;
  const entry = Object.values(docIndex).find(
    (candidate) => candidate.document_id === rawId,
  );
  if (entry) return entry.document_id;
  throw new Error(`Document is not available in this project: ${rawId}`);
}

function withResolvedDocumentIds(
  proposal: VerificationProposal,
  docIndex: DocIndex,
  artifacts: VerificationArtifactStore,
): VerificationProposal {
  return {
    ...proposal,
    memo: {
      ...proposal.memo,
      document_id: resolveDocumentId(
        proposal.memo.document_id,
        docIndex,
        new Map(),
      ),
    },
    sources: Object.fromEntries(
      Object.entries(proposal.sources).map(([key, source]) => [
        key,
        {
          ...source,
          document_id: resolveDocumentId(
            source.document_id,
            docIndex,
            artifacts,
          ),
        },
      ]),
    ),
  };
}

async function downloadResolvedDocument(
  documentId: string,
  version: VersionRow,
): Promise<ResolvedDocument> {
  if (!version.storage_path) {
    throw new Error(
      `Document version has no readable storage path: ${documentId}/${version.id}`,
    );
  }
  const content = await downloadFile(version.storage_path);
  if (!content) {
    throw new Error(
      `Document version could not be read from storage: ${documentId}/${version.id}`,
    );
  }
  const bytes = new Uint8Array(content);
  const fileType = version.file_type?.trim().toLowerCase() ?? "";
  if (fileType === "pdf" || fileType === "docx" || fileType === "doc") {
    throw new VerificationExtractionRequiredError(documentId, version.id);
  }
  return {
    documentId,
    versionId: version.id,
    filename: version.filename?.trim() || "Untitled document",
    bytes,
  };
}

export async function verifyCitationSources(
  input: {
    projectId: string;
    userId: string;
    proposal: unknown;
    docIndex: DocIndex;
    sourceArtifacts?: VerificationArtifactStore;
  },
  db: Db = createServerSupabase(),
): Promise<{
  runId: string;
  record: VerifiedRecord;
  report: VerificationReport;
}> {
  if (!input.projectId) {
    throw new Error("Citation verification requires an active project");
  }

  const artifacts = input.sourceArtifacts ?? new Map();
  const parsed = verificationProposalSchema.parse(input.proposal);
  const proposal = withResolvedDocumentIds(parsed, input.docIndex, artifacts);
  const requestedRefs = [
    proposal.memo,
    ...Object.values(proposal.sources),
  ].filter((reference) => !artifacts.has(reference.document_id));
  const documentIds = Array.from(
    new Set(requestedRefs.map((reference) => reference.document_id)),
  );

  // Resolve every document and version identity before the first storage
  // read. This snapshots omitted version ids into a deterministic run.
  const { data: documentData, error: documentError } = await db
    .from("documents")
    .select("id, project_id, current_version_id, status")
    .in("id", documentIds);
  if (documentError) throw new Error(documentError.message);
  const documents = (documentData ?? []) as DocumentRow[];
  const documentsById = new Map(documents.map((row) => [row.id, row]));
  for (const documentId of documentIds) {
    const row = documentsById.get(documentId);
    if (
      !row ||
      row.project_id !== input.projectId ||
      row.status !== "ready"
    ) {
      throw new Error(`Document is not accessible in this project: ${documentId}`);
    }
  }

  const resolvedVersionIds = new Map<string, string>();
  for (const reference of requestedRefs) {
    const document = documentsById.get(reference.document_id)!;
    const versionId = reference.version_id ?? document.current_version_id;
    if (!versionId) {
      throw new Error(`Document has no active version: ${reference.document_id}`);
    }
    const prior = resolvedVersionIds.get(reference.document_id);
    if (prior && prior !== versionId) {
      throw new Error(
        `Document was requested with conflicting versions: ${reference.document_id}`,
      );
    }
    resolvedVersionIds.set(reference.document_id, versionId);
  }

  const versionIds = Array.from(new Set(resolvedVersionIds.values()));
  const { data: versionData, error: versionError } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, filename, file_type")
    .in("id", versionIds)
    .is("deleted_at", null);
  if (versionError) throw new Error(versionError.message);
  const versions = (versionData ?? []) as VersionRow[];
  const versionsById = new Map(versions.map((row) => [row.id, row]));
  for (const [documentId, versionId] of resolvedVersionIds) {
    const version = versionsById.get(versionId);
    if (!version || version.document_id !== documentId) {
      throw new Error(
        `Document version is not accessible: ${documentId}/${versionId}`,
      );
    }
  }

  const memoVersionId = resolvedVersionIds.get(proposal.memo.document_id)!;
  const memo = await downloadResolvedDocument(
    proposal.memo.document_id,
    versionsById.get(memoVersionId)!,
  );
  const sources: Record<string, ResolvedDocument> = {};
  for (const [key, source] of Object.entries(proposal.sources)) {
    const artifact = artifacts.get(source.document_id);
    if (artifact) {
      if (source.version_id && source.version_id !== artifact.versionId) {
        throw new Error(
          `Verification source version mismatch: ${source.document_id} requested ${source.version_id}, registered ${artifact.versionId}`,
        );
      }
      sources[key] = {
        documentId: artifact.artifactId,
        versionId: artifact.versionId,
        filename: artifact.filename,
        bytes: new TextEncoder().encode(artifact.text),
        text: artifact.text,
        provider: artifact.provider,
        originUrl: artifact.originUrl,
      };
      continue;
    }
    const versionId = resolvedVersionIds.get(source.document_id)!;
    sources[key] = await downloadResolvedDocument(
      source.document_id,
      versionsById.get(versionId)!,
    );
  }

  const { record, report } = verifyResolvedProposal({
    proposal,
    memo,
    sources,
  });
  const { data: inserted, error: insertError } = await db
    .from("citation_verification_runs")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      memo_document_id: record.memo.document_id,
      memo_version_id: record.memo.version_id,
      verified_record: record,
      report,
    })
    .select("id")
    .single();
  if (insertError || !inserted?.id) {
    throw new Error(
      insertError?.message ?? "Failed to persist citation verification run",
    );
  }

  return {
    runId: String(inserted.id),
    record,
    report,
  };
}

export async function getCitationVerificationRun(
  runId: string,
  db: Db = createServerSupabase(),
): Promise<CitationVerificationRunRow | null> {
  const { data, error } = await db
    .from("citation_verification_runs")
    .select("id, project_id, verified_record, report, created_at")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: String(data.id),
    project_id: String(data.project_id),
    verified_record: verifiedRecordSchema.parse(data.verified_record),
    report: verificationReportSchema.parse(data.report),
    created_at: String(data.created_at),
  };
}
