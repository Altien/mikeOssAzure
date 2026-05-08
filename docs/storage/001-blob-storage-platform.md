# 001 — Blob storage platform

**Status:** Accepted

## Context

The application stores four categories of binary objects:

| Category | Path pattern | Notes |
|---|---|---|
| Source documents | `documents/{userId}/{docId}/source.{ext}` | PDF, DOCX, DOC uploaded by the user (up to 100 MB) |
| PDF renditions | `documents/{userId}/{docId}/{stem}.pdf` | LibreOffice-converted PDFs for DOCX/DOC originals |
| Generated documents | `generated/{userId}/{docId}/generated.docx` | AI-produced DOCX output from the editing feature |
| Document versions | `documents/{userId}/{docId}/versions/{slug}.{ext}` | Versioned snapshots of source documents |

The current implementation (`backend/src/lib/storage.ts`, now deleted `frontend/src/lib/storage.ts`) used the **AWS SDK v3** (`@aws-sdk/client-s3`) pointed at **Cloudflare R2** via env vars `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`.

## Decision

**Azure Blob Storage** (`@azure/storage-blob` + `@azure/identity`), authenticating via **Managed Identity** in Azure and `AZURE_STORAGE_CONNECTION_STRING` / Azurite locally. Files are served to the browser via the **backend download proxy** — no direct storage URLs are issued to clients.

Storage account layout:

```
Storage account: stmike<env>  (LRS, StorageV2, standard tier)
└─ Container: documents       (private — no anonymous reads)
```

All objects live in one private container. The existing key structure is preserved unchanged; only the SDK and auth mechanism change.

## Options considered

### Q1 — Azure Blob Storage or keep Cloudflare R2?

| Option | Pros | Cons |
|---|---|---|
| **A. Azure Blob Storage + Managed Identity** *(chosen)* | No access keys in Key Vault. MI is the credential primitive across the whole stack. Private endpoint keeps traffic inside the VNet. | Requires rewriting `storage.ts` from AWS SDK to `@azure/storage-blob`. |
| **B. Keep Cloudflare R2** | Zero code change. Already understood AWS SDK. Free egress. | External third-party dependency in an Azure-native deployment. Two access-key secrets in Key Vault that cannot use MI rotation. Traffic egresses the VNet to Cloudflare via NAT Gateway. |
| **C. Azure Data Lake Storage Gen2** | POSIX-style ACLs, good for analytics. | Wrong shape for a document store. No benefit over Blob Storage for this workload. |

### Q2 — One container or many?

| Option | Pros | Cons |
|---|---|---|
| **A. One container (`documents`)** *(chosen)* | Simple. MI role scoped to one container. Existing key prefixes provide logical separation. | Lifecycle policies apply by prefix filter, not container boundary. |
| **B. Multiple containers by category** | Per-category lifecycle and access roles. | More Bicep complexity, more role assignments, no concrete security requirement driving it. |
| **C. One container per user** | True isolation at the storage layer. | Container per-user created at signup — complex provisioning. |

### Q3 — Signed URLs or backend proxy for browser access?

| Option | Pros | Cons |
|---|---|---|
| **A. Signed / SAS URLs** | Browser fetches directly from storage; no blob data passes through the backend. | Credentials (even time-limited) leave the server. Signed URLs in browser history, server logs, CDN logs. |
| **B. Backend download proxy** *(chosen)* | No storage credentials ever reach the browser. Auth is enforced on every access. Consistent with the existing `/download/:token` pattern already in the codebase. | Large files (up to 100 MB) pass through the backend; limits scale-to-zero effectiveness for download-heavy workloads. |

## TypeScript provider interface

`storage.ts` exposes a stable public API. The provider that backs it is swapped without touching callers:

```typescript
export interface StorageProvider {
  upload(key: string, content: ArrayBuffer, contentType: string): Promise<void>;
  download(key: string): Promise<ArrayBuffer | null>;
  remove(key: string): Promise<void>;
  signedUrl(key: string, expiresIn: number, downloadFilename?: string): Promise<string | null>;
}
```

Two concrete implementations exist behind this interface:

| Class | Selected when |
|---|---|
| `R2Provider` | `R2_ENDPOINT_URL` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` are set |
| `AzureBlobProvider` | `AZURE_STORAGE_ACCOUNT_NAME` or `AZURE_STORAGE_CONNECTION_STRING` is set (Azure takes priority) |

`createProvider()` at module load selects the implementation. The four module-level functions (`uploadFile`, `downloadFile`, `deleteFile`, `getSignedUrl`) delegate to the singleton — call sites never change.

`AzureBlobProvider.signedUrl()` returns `null`. The `/url` route in `documents.ts` already handles this: when `getSignedUrl` returns null it falls back to `buildDownloadUrl()`, which issues an HMAC-signed `/download/:token` URL served by the existing backend proxy route. The frontend receives a URL in both cases and behaves identically.

## Consequences

### Auth and secrets

- The `r2-access-key-id` and `r2-secret-access-key` Key Vault slots (see `docs/infra/003-secrets-and-identity.md`) are **removed**.
- The backend Container App's system-assigned MI is granted `Storage Blob Data Contributor` on the storage account (scoped to the `documents` container).
- No connection string or account key appears in application config in production.

### Code changes made

- `backend/src/lib/storage.ts` — rewritten with `StorageProvider` interface, `R2Provider`, `AzureBlobProvider`, factory. Public function signatures unchanged.
- `backend/src/routes/documents.ts` — `/url` route falls back to `buildDownloadUrl()` when `getSignedUrl()` returns null.
- `backend/package.json` — added `@azure/storage-blob ^12.26.0`, `@azure/identity ^4.5.0`. AWS SDK packages retained for R2 compatibility.
- `frontend/src/lib/storage.ts` — deleted (was dead code; no frontend component imported it).
- `frontend/package.json` — removed `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `resend`.

### Network

The storage account is placed in the same region as the Container Apps Environment (default `westeurope`). A **Private Endpoint** is added in `subnet-pe` alongside the Postgres private endpoint, with Private DNS Zone `privatelink.blob.core.windows.net`. Public network access on the storage account is set to **Disabled**.

### Local development

```bash
# Azurite (local emulator)
AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true

# Or a real Azure storage account with az login credentials
AZURE_STORAGE_ACCOUNT_NAME=<your-storage-account>
```

`DefaultAzureCredential` picks up `az login` credentials automatically for the account-name path.

### Bicep additions

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'stmike${env}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}
```

Role assignment (`Storage Blob Data Contributor`) and private endpoint follow the same pattern as Postgres (see `docs/infra/001-network-topology.md`).

### Data migration (Q7)

No migration required — this is a greenfield Azure deployment with no existing R2 objects to carry over.

### Deferred

- **Lifecycle management policy** — tier documents to Cool/Archive after N days of inactivity. Defer until usage data justifies it.
- **Blob soft delete** — 7-day retention for accidental deletes. Low-effort Bicep addition; add in the same pass as initial provisioning.
- **Storage SKU upgrade** — `Standard_LRS` → `Standard_ZRS` when a written SLA requires zone redundancy.
- **Customer self-hosted deployments** — customer brings their own storage account; `AZURE_STORAGE_ACCOUNT_NAME` is a Bicep parameter they override. The MI role assignment targets the customer's account.
