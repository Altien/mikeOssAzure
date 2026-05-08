# Azure Migration Research Proposal

## Objective
Move this app to Azure-native services with minimal recurring cost while preserving core functionality:
- Identity with Microsoft Entra ID
- File/object storage with Azure Blob Storage
- Retrieval/indexing with Azure AI Search
- Relational DB with the cheapest practical Azure PostgreSQL option

## Current-state findings (from repo)
- Auth currently depends on Supabase JWT validation in both backend and frontend helper utilities.
- Data model/migrations include direct dependencies on Supabase auth schema (`auth.users`) and RLS policies.
- Object storage is implemented via an S3-compatible client (Cloudflare R2 env vars and key conventions).
- App structure is Next.js frontend + Express backend.

## Target Azure Architecture (cost-conscious baseline)
1. **Identity**: Microsoft Entra External ID (customer-facing identities) or Entra workforce tenant (if internal-only users).
2. **Database**: Azure Database for PostgreSQL Flexible Server, **Burstable** compute tier (smallest SKU that meets load).
3. **Object storage**: Azure Storage Account (Blob), **Standard + LRS**, with lifecycle tiering.
4. **Search/RAG index**: Azure AI Search **Basic** tier (or Free for prototype only).
5. **Hosting**:
   - Lowest ops friction: Azure App Service (Linux) for backend and frontend.
   - Lowest cost at tiny scale: Azure Container Apps consumption profile (if traffic is sporadic).
6. **Secrets/config**: Azure Key Vault + Managed Identity.

---

## Service-by-service recommendations

### 1) Identity: Entra ID options

#### Option A (recommended for B2C/external users): Entra External ID
- Why: Managed customer identity flows; first MAU band is free before paid usage.
- Fit: If this product has external customers outside your org tenant.
- Implementation notes:
  - Frontend: use MSAL (OIDC/OAuth2 authorization code + PKCE).
  - Backend: validate JWT via Entra JWKS and audience checks.
  - Replace Supabase auth calls with Entra claims parsing and user bootstrap.

#### Option B (internal employees only): Entra ID workforce tenant
- Why: Often already licensed by org; may be cheapest if only internal users.
- Limitation: Not meant as public consumer identity.

**Recommendation:**
- If this is public/customer-facing: **External ID**.
- If strictly internal: **workforce tenant auth**.

---

### 2) PostgreSQL on Azure (cheapest practical)

#### Option A (recommended): PostgreSQL Flexible Server, Burstable (B-series)
- Start with smallest burstable SKU (e.g., B1ms-class equivalent in region).
- Enable stop/start for non-prod environments.
- Use low storage baseline, enable autogrow conservatively.
- Best managed-DB balance of cost + reliability.

#### Option B: Run PostgreSQL in a VM/container
- Can be cheaper at very small scale.
- But adds backup/patching/HA/ops burden; generally false economy for teams.

**Recommendation:** Flexible Server Burstable for production and dev.

---

### 3) Blob Storage

#### Recommended setup
- Storage Account: **Standard GPv2 + LRS** (cheapest redundancy).
- Container split:
  - `documents-source`
  - `documents-generated`
  - `documents-pdf`
- Lifecycle rules:
  - Move stale blobs from Hot to Cool/Cold after N days.
  - Consider Archive only for very infrequent access due to retrieval penalties.

#### App mapping
- Replace S3 SDK wiring with Azure Blob SDK.
- Keep current key patterns (`documents/{user}/{doc}/...`) to minimize code churn.
- Use short-lived SAS URLs where direct download/upload is needed.

---

### 4) Azure AI Search

#### Option A (recommended for production): Basic tier
- Minimal production-capable tier.
- Supports vector/search features needed for document retrieval scenarios.

#### Option B (prototype only): Free tier
- Good for development spikes.
- Not suitable for production scale/capacity.

**Recommendation:** Start with **Basic** in one region, keep index design lean.

---

## Migration impact in this codebase

### A) Auth replacement (highest change)
- Replace Supabase token validation paths:
  - `backend/src/middleware/auth.ts`
  - `backend/src/lib/supabase.ts` (user extraction usage)
  - `frontend/src/lib/auth.ts`
- Remove Supabase client usage for auth checks and user bootstrap.
- Add Entra JWT validation middleware and claim-to-user mapping.

### B) DB schema adjustments
- Current schema references `auth.users` and `auth.uid()` policies.
- For Azure PostgreSQL, create app-owned `users` table and refactor FKs/RLS assumptions.
- Keep `user_id` as text/uuid mapped to Entra `oid`/subject.

### C) Storage abstraction swap
- Update `backend/src/lib/storage.ts` from R2/S3 client to Blob SDK.
- Maintain storage key helper APIs to avoid touching route-level business logic.

### D) Search integration
- Add ingestion pipeline when document is uploaded/converted:
  - extract text/chunks
  - upsert into AI Search index
  - store document/chunk IDs for traceability

---

## Cost-minimization blueprint (initial)
1. Single Azure region close to users.
2. LRS (not GRS) for Blob unless DR requirement mandates cross-region.
3. One small Postgres burstable server; no read replicas initially.
4. Azure AI Search Basic, 1 replica/partition equivalent minimum.
5. Non-prod environments auto-stop where supported (DB + apps).
6. Strict lifecycle policies on Blob and logs.
7. Budget alerts + cost anomaly alerts from day 1.

---

## Open/interesting questions for grill session

### Q1. Identity mode choice
- **Option 1:** Entra External ID now.
- **Option 2:** Workforce-only tenant now; later External ID migration.
- **Option 3:** Keep Supabase Auth temporarily while migrating other infra first.

**My recommendation:** Option 1 for customer-facing products to avoid double migration.

### Q2. Hosting strategy
- **Option 1:** App Service for frontend+backend (simpler operations).
- **Option 2:** Container Apps consumption (better for spiky/low traffic).
- **Option 3:** AKS (not cost-optimal at current stage).

**My recommendation:** Option 2 if traffic is intermittent; else Option 1.

### Q3. Search rollout depth
- **Option 1:** Full chunked indexing + vector search in phase 1.
- **Option 2:** Keyword/BM25 first, vector in phase 2.
- **Option 3:** No AI Search initially, DB metadata search only.

**My recommendation:** Option 2 for fastest value with lower initial complexity.

### Q4. Data model migration timing
- **Option 1:** Big-bang cutover from Supabase schema to Azure Postgres.
- **Option 2:** Dual-write transition window.
- **Option 3:** Fresh-start Azure with selective data backfill.

**My recommendation:** Option 3 for fastest path if legacy data volume is manageable.

---

## Proposed phased plan

### Phase 0 (1 week): Design + POC
- Entra login POC in frontend
- Backend JWT validation middleware POC
- Blob upload/download POC
- Postgres connectivity + migrated minimal schema

### Phase 1 (1–2 weeks): Core infra cutover
- Replace auth middleware + user model
- Replace storage adapter
- Deploy to chosen compute platform

### Phase 2 (1–2 weeks): AI Search integration
- Build indexing pipeline for uploaded docs
- Query-time retrieval wiring
- relevance tuning

### Phase 3 (1 week): Hardening + cost controls
- Monitoring, budgets, autoscaling bounds
- Lifecycle management and retention
- Load/perf validation and right-sizing

---

## Key risks and mitigations
- **Risk:** Supabase-specific SQL assumptions break on Azure Postgres.
  - **Mitigation:** Introduce explicit app `users` table and remove Supabase auth schema coupling first.
- **Risk:** AI Search costs grow with over-indexing.
  - **Mitigation:** Chunk size limits, document retention rules, and index only needed fields.
- **Risk:** Blob retrieval costs spike with cold tiers.
  - **Mitigation:** Conservative lifecycle rules and monitoring before moving to colder tiers.

---

## Reference links used during research
- Entra External ID pricing: https://learn.microsoft.com/entra/external-id/external-identities-pricing
- Azure Database for PostgreSQL Flexible Server pricing: https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/
- Azure Blob Storage pricing: https://azure.microsoft.com/en-us/pricing/details/storage/blobs/
- Azure AI Search tier guidance: https://learn.microsoft.com/azure/search/search-sku-tier


## Decision capture from review (May 4, 2026)
Selected options:
- Q1 Identity mode: **Option 2** (Workforce-only tenant now; External ID later if needed).
- Q2 Hosting strategy: **Option 1** (App Service for frontend + backend).
- Q3 Search rollout depth: **Option 2** (Keyword/BM25 first, vector in phase 2).
- Q4 Data model migration timing: **Option 1** (Big-bang cutover).

## Detailed implementation plan (based on selected options)

### Track A — Identity (Entra workforce first)
1. Create Entra app registrations:
   - Frontend SPA app (PKCE).
   - Backend API app (expose API scope).
2. Configure login flows and redirect URIs for dev/stage/prod.
3. Frontend integration:
   - Add MSAL auth provider.
   - Replace Supabase session/token acquisition with Entra access token flow.
4. Backend integration:
   - Add JWT validation middleware using Entra tenant issuer + JWKS.
   - Validate `aud`, `iss`, token expiry, and required scopes.
   - Populate `res.locals.userId` from Entra `oid` claim.
5. User bootstrap:
   - On first authenticated request, upsert into app-owned `users` table.

Deliverables:
- Login/logout operational in dev and stage.
- Supabase auth dependency removed from request path.

### Track B — PostgreSQL big-bang cutover
1. Provision Azure Database for PostgreSQL Flexible Server (Burstable).
2. Create new migration set for Azure-native schema:
   - Add `public.users` table (Entra user mapping).
   - Replace `auth.users` foreign keys.
   - Remove `auth.uid()`-based RLS assumptions and replace with app-enforced access patterns.
3. Data migration prep:
   - Export current Supabase tables.
   - Transform user identifiers to Entra `oid` compatible format where needed.
4. Dry run in staging:
   - Restore transformed dump to Azure Postgres.
   - Run app regression checks.
5. Cutover sequence (single-window):
   - Freeze writes.
   - Final export/import delta.
   - Switch connection strings.
   - Smoke test core workflows.

Deliverables:
- App points only to Azure Postgres.
- No runtime dependencies on Supabase schema/auth objects.

### Track C — Storage migration to Azure Blob
1. Provision storage account (Standard GPv2 + LRS) and containers.
2. Replace `backend/src/lib/storage.ts` implementation with Azure Blob SDK while preserving key helper signatures.
3. Implement SAS URL generation for download/upload endpoints.
4. Migrate existing blobs from R2 to Blob using one-time transfer script.
5. Add lifecycle policies (Hot -> Cool after threshold days).

Deliverables:
- Upload/download/delete working against Blob.
- Existing documents accessible after migration.

### Track D — Azure AI Search rollout (Q3 Option 2)
Phase 1 (keyword/BM25 first):
1. Define lean index schema (document metadata + chunk text + ACL fields).
2. Build ingestion pipeline triggered by upload/convert completion.
3. Add keyword retrieval endpoint and integrate in chat/doc workflows.

Phase 2 (vector):
4. Add embedding generation and vector fields.
5. Implement hybrid retrieval and relevance tuning.

Deliverables:
- Phase 1: production keyword retrieval.
- Phase 2: hybrid/vector retrieval.

### Track E — Hosting on App Service (Q2 Option 1)
1. Provision two Linux Web Apps:
   - `mike-frontend` (Next.js runtime strategy chosen by build output).
   - `mike-backend` (Node/Express).
2. Configure deployment pipeline (GitHub Actions or Azure DevOps).
3. Add Managed Identity for apps and Key Vault references.
4. Configure health checks, autoscale floor/ceiling, and diagnostic logging.

Deliverables:
- Reproducible CI/CD to App Service.
- Secure secret handling via Key Vault.

## Timeline and milestones (detailed)
- **Week 1:** Identity + App Service scaffolding in dev.
- **Week 2:** Postgres schema migration drafts + Blob adapter implementation.
- **Week 3:** Staging cutover rehearsal (DB + Blob), bug fixes.
- **Week 4:** Production big-bang cutover window.
- **Week 5:** AI Search Phase 1 (keyword).
- **Week 6+:** AI Search Phase 2 (vector/hybrid), tuning, cost right-sizing.

## Cutover runbook (production)
1. Announce maintenance window.
2. Disable write endpoints.
3. Run final data export/import.
4. Verify DB row counts/checksums for critical tables.
5. Flip app configuration to Azure services.
6. Run smoke tests:
   - Login
   - Project/document listing
   - Upload/download
   - Chat create/send
7. Re-enable traffic.
8. Monitor error rate/latency/cost for 24–48 hours.

## Acceptance criteria
- 100% auth flows on Entra workforce tenant.
- 0 Supabase calls in backend/frontend request paths.
- All document operations succeed on Blob.
- Postgres queries and migrations stable on Azure Flexible Server.
- AI Search keyword retrieval live (vector pending phase 2).

