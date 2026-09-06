import { readFile } from "fs/promises";
import { contentTypeForDocumentType } from "./documentTypes";
import { storageEnabled, uploadFile } from "./storage";
import type { ServerDatabase } from "./database";
import {
  prepareWorkflowCatalog,
  removePreparedWorkflowCatalog,
  validateWorkflowCatalogDocument,
  type WorkflowCatalogSourceOptions,
  type WorkflowCatalogSourceWorkflow,
} from "./workflowCatalogSource";

type Db = ServerDatabase;

export type WorkflowCatalogSyncResult = {
  workflows: number;
  references: number;
  sourceCommit: string;
};

function metadataWithoutTemporaryReferences(
  workflow: WorkflowCatalogSourceWorkflow,
  referenceFiles: Array<{
    filename: string;
    file_type: string;
    storage_path: string;
    size_bytes: number;
    content_hash: string;
  }>,
) {
  const { reference_files: _references, ...metadata } = workflow;
  return { ...metadata, reference_files: referenceFiles };
}

export async function syncWorkflowCatalog(
  db: Db,
  options: WorkflowCatalogSourceOptions = {},
): Promise<WorkflowCatalogSyncResult> {
  const prepared = await prepareWorkflowCatalog(options);
  try {
    const document = validateWorkflowCatalogDocument(
      JSON.parse(await readFile(prepared.catalogPath, "utf8")) as unknown,
    );
    let references = 0;
    const databaseWorkflows = [];
    const hasReferences = document.workflows.some(
      (workflow) => workflow.reference_files.length > 0,
    );
    if (hasReferences && !storageEnabled) {
      throw new Error(
        "Workflow reference files require configured S3-compatible storage",
      );
    }

    for (const workflow of document.workflows) {
      const databaseReferences = [];
      for (const reference of workflow.reference_files) {
        if (storageEnabled) {
          const storagePath =
            `mike-workflows/${workflow.workflow_key}/` +
            `${reference.content_hash}/${reference.filename}`;
          const bytes = await readFile(reference.temporary_path);
          await uploadFile(
            storagePath,
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
            contentTypeForDocumentType(reference.file_type),
          );
          databaseReferences.push({
            filename: reference.filename,
            file_type: reference.file_type,
            storage_path: storagePath,
            size_bytes: reference.size_bytes,
            content_hash: reference.content_hash,
          });
          references += 1;
        }
      }
      databaseWorkflows.push(
        metadataWithoutTemporaryReferences(workflow, databaseReferences),
      );
    }

    const { error } = await db.rpc("replace_mike_workflows", {
      p_source_commit: document.source_commit,
      p_workflows: databaseWorkflows,
    });
    if (error) throw error;

    return {
      workflows: databaseWorkflows.length,
      references,
      sourceCommit: document.source_commit,
    };
  } finally {
    await removePreparedWorkflowCatalog(prepared);
  }
}
