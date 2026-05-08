# Storage decisions

This folder captures the Azure storage decisions for the Supabase → Azure-native migration, specifically the replacement of Cloudflare R2 with Azure Blob Storage.

## Context

MikeOSS stores user-uploaded documents (PDF, DOCX, DOC), LibreOffice-converted PDF renditions, AI-generated DOCX files, and versioned document snapshots. The current implementation uses Cloudflare R2 (S3-compatible) via the AWS SDK v3. This folder documents the decision to migrate to Azure Blob Storage.

## Index

| # | Title | Summary |
|---|---|---|
| 001 | [Blob storage platform](001-blob-storage-platform.md) | Azure Blob Storage with Managed Identity replacing Cloudflare R2 + AWS SDK |

## Cross-cutting principles

1. **No storage access keys.** The system-assigned Managed Identity on the backend Container App is the sole credential for storage access in production. No `AZURE_STORAGE_ACCOUNT_KEY` appears in Key Vault or env vars.
2. **Private by default.** The storage account blocks public network access. All traffic routes through the private endpoint in `subnet-pe`.
3. **Unchanged application interface.** The four-function surface (`uploadFile`, `downloadFile`, `deleteFile`, `getSignedUrl`) is preserved. Callers — document upload routes, download routes, AI context readers — require no changes.
4. **Same key structure.** Blob keys (`documents/{userId}/{docId}/`, `generated/{userId}/{docId}/`) are unchanged. No data migration is required beyond a one-time copy from R2 to Azure Blob Storage for existing objects.
