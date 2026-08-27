# MikeOSS Library + Global Exchange Blueprint

This blueprint describes a concrete implementation for a SQLite-backed Library service inside MikeOSS and a publicly accessible global sharing service for non-sensitive prompts and gold-standard examples. Public descriptions of MikeOSS show a Next.js frontend, Express backend, Supabase-backed migrations in some releases, reusable workflows, projects vaults, and document review capabilities, while Mike’s Library is explicitly organized around prompts, workflow agents, and examples that can be saved and reused.[cite:50][cite:51][cite:11][cite:52]

## Objectives

The design has two distinct goals:

1. Add a **tenant-local Library** to MikeOSS for prompts, workflows, and gold-standard examples, with versioning, approvals, search, and promotion from prior work.[cite:11][cite:52]
2. Add a **public exchange service** where MikeOSS users worldwide can publish and install only sanitized, non-sensitive prompt/example packages, without exposing live matter data or private firm artifacts.[cite:50][cite:52]

The critical architectural principle is separation of concerns: private matter and tenant knowledge remain in the MikeOSS deployment, while the public service stores only derived publication packages created through a redaction and approval pipeline. Mike’s examples are described as a combination of prompt, source materials, and response, and that is precisely why publication must be copy-based and policy-gated rather than direct sharing of internal assets.[cite:52]

## Scope boundaries

The local Library supports three first-class asset types:

- **Prompt**: reusable single-step instruction templates.
- **Workflow**: reusable multi-step prompt chains, extraction pipelines, or review flows.
- **Example**: a gold-standard reference package containing prompt version, sanitized source context, expected output characteristics, and review rubric.[cite:52][cite:57]

The public exchange supports only publication packages derived from approved prompt or example assets. Workflows may be published later, but the initial launch should focus on prompts and examples because they are easier to sanitize, evaluate, and consume safely.[cite:52]

## Target architecture

### Local MikeOSS deployment

Recommended runtime components:

- **Next.js UI** for Library browsing, promotion, review, evaluation, and publishing controls.[cite:50]
- **Express API** for Library CRUD, revision management, search, evaluation, and publication workflows.[cite:50][cite:51]
- **SQLite** as the primary transactional database because the user’s environment standard is SQLite for the legal AI stack.
- **FTS5** for keyword search over titles, summaries, prompt bodies, rubric text, and sanitized example content.
- **Object storage or filesystem** for larger blobs such as publication manifests, rendered evaluation outputs, or exported packages.
- **Background job runner** for evaluation, redaction, and publication packaging.

SQLite is appropriate for the local Library because it offers a low-friction embedded store, strong transactional guarantees, JSON support through JSON1, and FTS5 for practical local search. The public sharing service, however, should not use a single shared SQLite file for global multi-tenant traffic; it should use a server-grade relational database such as PostgreSQL for concurrency, HA, moderation workflows, and analytics. The split preserves SQLite where it fits and avoids forcing it into a world-scale SaaS role.

### Public global exchange

Recommended runtime components:

- **Public web API** for publishing, browsing, searching, rating, and installing packages.
- **Publisher console** for moderation, revocation, trust controls, and package lifecycle management.
- **Relational database** for multi-tenant package metadata, moderation state, usage telemetry, and publisher identities.
- **Blob storage + CDN** for immutable package files, thumbnails, and signed manifests.
- **Search index** for low-latency browse/filter by practice area, jurisdiction, asset type, language, and tags.
- **Moderation pipeline** for abuse review, malware screening of attachments, and policy checks.

This architecture mirrors the pattern used by package registries and app marketplaces: local systems author and package content; the public service distributes immutable, signed artifacts with policy enforcement.

## Local SQLite schema

The schema below treats every Library asset as versioned content with strong lineage and publication boundaries.

### Core tables

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('contributor','reviewer','library_admin','exchange_admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('prompt','workflow','example')),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','team','tenant')) DEFAULT 'private',
  status TEXT NOT NULL CHECK (status IN ('draft','candidate','approved','deprecated','archived')) DEFAULT 'draft',
  practice_area TEXT,
  jurisdiction TEXT,
  language TEXT DEFAULT 'en',
  tags_json TEXT NOT NULL DEFAULT '[]',
  owner_user_id TEXT NOT NULL,
  latest_revision_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (latest_revision_id) REFERENCES item_revisions(id)
);

CREATE TABLE item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  revision_note TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual','promoted_from_chat','promoted_from_workflow','forked_from_exchange')),
  source_ref_json TEXT,
  evaluation_state TEXT NOT NULL CHECK (evaluation_state IN ('not_run','pass','fail','warning')) DEFAULT 'not_run',
  approved_by_user_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(item_id, revision_number),
  FOREIGN KEY (item_id) REFERENCES library_items(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id)
);

CREATE TABLE item_links (
  id TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('uses_prompt','uses_example','derived_from','paired_with','supersedes')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (from_item_id) REFERENCES library_items(id) ON DELETE CASCADE,
  FOREIGN KEY (to_item_id) REFERENCES library_items(id) ON DELETE CASCADE
);
```

### Example, workflow, and evaluation tables

```sql
CREATE TABLE example_rubrics (
  id TEXT PRIMARY KEY,
  item_revision_id TEXT NOT NULL UNIQUE,
  rubric_json TEXT NOT NULL,
  acceptance_threshold REAL NOT NULL,
  reviewer_notes TEXT,
  FOREIGN KEY (item_revision_id) REFERENCES item_revisions(id) ON DELETE CASCADE
);

CREATE TABLE evaluation_runs (
  id TEXT PRIMARY KEY,
  item_revision_id TEXT NOT NULL,
  executed_by_user_id TEXT,
  model_provider TEXT,
  model_name TEXT,
  score REAL,
  result_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (item_revision_id) REFERENCES item_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (executed_by_user_id) REFERENCES users(id)
);

CREATE TABLE publication_candidates (
  id TEXT PRIMARY KEY,
  item_revision_id TEXT NOT NULL UNIQUE,
  candidate_type TEXT NOT NULL CHECK (candidate_type IN ('prompt_package','example_package')),
  sensitivity_report_json TEXT,
  redacted_content_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','redaction_failed','awaiting_review','approved','rejected','published')) DEFAULT 'queued',
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  published_package_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (item_revision_id) REFERENCES item_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)
);

CREATE TABLE publication_audit_log (
  id TEXT PRIMARY KEY,
  publication_candidate_id TEXT NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  event_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (publication_candidate_id) REFERENCES publication_candidates(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
```

### Search tables

```sql
CREATE VIRTUAL TABLE library_search USING fts5(
  item_id UNINDEXED,
  revision_id UNINDEXED,
  title,
  summary,
  tags,
  practice_area,
  jurisdiction,
  content,
  rubric,
  tokenize = 'porter unicode61'
);
```

The application should update `library_search` from triggers or application-layer upserts whenever a revision changes. SQLite FTS5 is sufficient for local browse and filter, especially when combined with exact-match columns in `library_items`.[cite:50]

## JSON payload contracts

A consistent JSON shape matters more than ORM choice. Use immutable revision payloads with a typed `schema_version`.

### Prompt revision payload

```json
{
  "schema_version": 1,
  "kind": "prompt",
  "prompt_text": "Review the change-of-control clause and identify lender consent triggers.",
  "placeholders": [
    {"name": "document_excerpt", "type": "text", "required": true},
    {"name": "jurisdiction", "type": "string", "required": false}
  ],
  "expected_output": {
    "format": "markdown",
    "sections": ["Summary", "Consent Triggers", "Risk Notes", "Citations"]
  },
  "model_hints": {
    "temperature": 0.1,
    "reasoning": "medium"
  },
  "safety_notes": ["Do not infer missing clause text."]
}
```

### Example revision payload

```json
{
  "schema_version": 1,
  "kind": "example",
  "prompt_revision_ref": "rev_prompt_123",
  "sanitized_inputs": {
    "document_type": "credit_agreement",
    "source_excerpt": "Borrower shall not undergo a Change of Control without prior written consent of Required Lenders.",
    "context": {
      "jurisdiction": "New York",
      "clause_family": "change_of_control"
    }
  },
  "gold_output": {
    "summary": "Consent is required before a change of control.",
    "findings": [
      "Prior written consent of Required Lenders is an express condition.",
      "The trigger is broad and not limited to merger transactions."
    ],
    "citation_expectations": [
      "Quote the operative consent language.",
      "Identify the triggering phrase 'Change of Control'."
    ]
  },
  "rubric_ref": "rubric_456"
}
```

### Workflow revision payload

```json
{
  "schema_version": 1,
  "kind": "workflow",
  "steps": [
    {"id": "classify", "type": "prompt", "prompt_ref": "item_prompt_classify", "on_success": "extract"},
    {"id": "extract", "type": "prompt", "prompt_ref": "item_prompt_extract", "on_success": "draft"},
    {"id": "draft", "type": "prompt", "prompt_ref": "item_prompt_draft", "on_success": "complete"}
  ],
  "input_contract": {
    "required_artifacts": ["uploaded_document"],
    "required_fields": ["matter_type"]
  }
}
```

## Local API design

The API should remain simple, explicit, and CLI-friendly.

### Library endpoints

```http
GET    /api/library/items
POST   /api/library/items
GET    /api/library/items/:id
POST   /api/library/items/:id/revisions
POST   /api/library/items/:id/approve
POST   /api/library/items/:id/deprecate
GET    /api/library/search?q=change+of+control&itemType=prompt&practiceArea=finance
POST   /api/library/promote/chat-run/:runId
POST   /api/library/promote/workflow-run/:runId
GET    /api/library/items/:id/evaluations
POST   /api/library/items/:id/evaluations
```

### Publication endpoints

```http
POST   /api/publication/candidates
GET    /api/publication/candidates/:id
POST   /api/publication/candidates/:id/redact
POST   /api/publication/candidates/:id/review
POST   /api/publication/candidates/:id/publish
GET    /api/publication/audit/:candidateId
```

### Exchange install/fork endpoints

```http
POST   /api/exchange/import
POST   /api/exchange/import/:packageId/fork
GET    /api/exchange/updates
```

### Example response shape

```json
{
  "item": {
    "id": "lib_123",
    "itemType": "prompt",
    "title": "Change of Control Review",
    "status": "approved",
    "latestRevision": {
      "id": "rev_008",
      "revisionNumber": 8,
      "evaluationState": "pass"
    }
  }
}
```

The CLI wrapper can map cleanly to this API, which matches the user’s preference for API-first and command-line workflows.[cite:44]

## Promotion flow inside MikeOSS

A practical promotion flow should start from existing work rather than asking users to recreate assets manually. MikeOSS already advertises reusable workflows and document-centered review, so promotion should be available from completed chat runs and workflow executions.[cite:11][cite:17]

### Save as Prompt

1. User selects a successful chat turn.
2. UI extracts prompt text, system context, output shape, and optional placeholders.
3. User edits title, summary, tags, and safety notes.
4. API creates `library_items` row and revision payload.
5. Search index updates and item becomes available immediately in draft state.

### Save as Example

1. User selects a successful run or reviewed work product.
2. UI captures prompt ref, source snippets, output, citations, and review notes.
3. Reviewer adds rubric and acceptance threshold.
4. Example stays tenant-local until approved.

### Save as Workflow

1. User selects a reusable multi-step chain or manually composes one.
2. Workflow JSON references prompt assets by stable item id.
3. Version increments whenever step graph changes.

## Evaluation framework

Gold-standard examples should be executable test fixtures, not passive references. Mike’s Library examples are referenceable assets; MikeOSS can go further by operationalizing them for regression testing.[cite:52]

Recommended scoring dimensions:

- Structural correctness.
- Citation correctness.
- Coverage of required findings.
- Hallucination avoidance.
- Clause/risk classification accuracy.
- Reviewer acceptability.

Each example rubric should define weighted criteria. A sample rubric payload:

```json
{
  "criteria": [
    {"name": "identifies_trigger", "weight": 0.35, "method": "rule", "expected": true},
    {"name": "quotes_operational_language", "weight": 0.20, "method": "rule", "expected": true},
    {"name": "mentions_required_lenders", "weight": 0.20, "method": "keyword", "expected": ["Required Lenders"]},
    {"name": "avoids_unfounded_assumptions", "weight": 0.25, "method": "reviewer_or_llm_judge"}
  ],
  "pass_threshold": 0.85
}
```

Evaluation should run asynchronously and write back a normalized score plus artifact outputs. Approved assets with repeated evaluation failures should automatically move into `warning` state.

## Redaction and publication pipeline

The publication pipeline is the most important control surface for safe global sharing.

### Redaction stages

1. **Entity detection**: names, organizations, addresses, dates, emails, signatures, deal values, account numbers, matter IDs, file names, quoted document blocks.
2. **Pattern detection**: contract references, custom internal taxonomy terms, folder paths, DMS IDs, and email threads.
3. **Contextual screening**: reject examples whose value depends on too much original source text.
4. **Placeholder transformation**: convert sensitive tokens into typed placeholders.
5. **Human review**: reviewer inspects the derived public package.
6. **Package signing**: approved publication is serialized, hashed, and signed.

### Public package format

```json
{
  "package_schema": 1,
  "package_type": "example",
  "package_id": "pkg_abc123",
  "publisher": {
    "handle": "dmcqueen-lab",
    "display_name": "Duncan Lab"
  },
  "source": {
    "origin_item_type": "example",
    "origin_revision_hash": "sha256:...",
    "created_at": "2026-07-29T11:00:00Z"
  },
  "metadata": {
    "title": "Change of Control Clause Review Example",
    "summary": "Gold-standard review example for lender consent triggers.",
    "practice_area": "finance",
    "jurisdiction": "US-NY",
    "tags": ["credit-agreement", "change-of-control", "clause-review"]
  },
  "content": {
    "prompt": "Review the clause and identify lender consent triggers.",
    "sanitized_input": {
      "source_excerpt": "[PARTY_A] shall not undergo a [CONTROL_EVENT] without prior written consent of [LENDER_GROUP]."
    },
    "gold_output": {
      "summary": "Consent is required before the control event.",
      "findings": [
        "The clause creates an express prior-consent requirement.",
        "The consenting body is the defined lender group."
      ]
    },
    "rubric": {
      "pass_threshold": 0.85,
      "criteria": [
        {"name": "identifies_trigger", "weight": 0.35},
        {"name": "identifies_consent_party", "weight": 0.35},
        {"name": "avoids_hallucination", "weight": 0.30}
      ]
    }
  },
  "license": {
    "content_license": "CC-BY-4.0",
    "terms_url": "https://exchange.mikeoss.org/terms"
  },
  "integrity": {
    "hash": "sha256:...",
    "signature": "ed25519:..."
  }
}
```

The package should be immutable after publication. Updates create new versions with explicit supersession links.

## Public global exchange blueprint

### Product goals

The global service should function like a curated package registry for legal AI prompts and benchmark examples. MikeOSS users across jurisdictions can publish, search, install, fork, review, and subscribe to updates, while the service enforces moderation and provenance.

### Core capabilities

- Search by practice area, jurisdiction, language, document type, clause family, asset type, and popularity.
- Publisher profiles with trust level and moderation history.
- Package pages with version history, changelog, install command, evaluation rubric summary, and preview.
- Verified publisher badges for known institutions.
- API tokens for automated publish/install from MikeOSS deployments.
- Abuse reporting and revocation.
- Optional consortium spaces for private sharing among member firms or departments.

### Public service architecture

```text
MikeOSS local instance
  -> package builder
  -> signer
  -> publish API client
        |
        v
Global Exchange API
  -> auth service
  -> package registry service
  -> moderation service
  -> search service
  -> analytics service
  -> blob storage / CDN
  -> PostgreSQL metadata store
```

### Suggested public endpoints

```http
POST   /v1/publish
GET    /v1/packages
GET    /v1/packages/:packageId
GET    /v1/packages/:packageId/versions
POST   /v1/packages/:packageId/report
POST   /v1/packages/:packageId/install-token
POST   /v1/publishers/verify
GET    /v1/search?q=change+of+control&practiceArea=finance&jurisdiction=US-NY
```

### Suggested public database model

| Table | Purpose |
|---|---|
| `publishers` | Publisher identity, verification state, trust score, profile metadata |
| `packages` | Stable package identity and latest version pointer |
| `package_versions` | Immutable published versions and manifest metadata |
| `package_files` | Blob references, checksums, signatures |
| `package_tags` | Search and browse tagging |
| `moderation_cases` | Reports, actions, review notes, revocations |
| `install_events` | Download/install telemetry |
| `ratings_reviews` | Community quality feedback |
| `consortium_spaces` | Private shared spaces for closed groups |

### Security model

- Publishers authenticate with API keys or OAuth device flow.
- Every package version is signed locally before upload.
- The public service verifies manifest integrity and rejects malformed or unsigned packages.
- Moderation can delist a package without deleting its historical record.
- Install clients verify signature and checksum before import.
- Imports are forked into the local tenant Library, not executed from the public service directly.

## Example publish/install workflow

### Publish

```text
1. Reviewer approves local example.
2. Publication candidate runs redaction and human review.
3. MikeOSS builds manifest + content bundle.
4. MikeOSS signs bundle with publisher key.
5. Client POSTs bundle to /v1/publish.
6. Exchange validates, scans, stores, and indexes package.
7. Package becomes searchable after moderation pass.
```

### Install

```text
1. User browses package in public exchange UI.
2. User clicks Install or uses CLI.
3. Local MikeOSS fetches manifest and bundle.
4. Signature and checksum verified.
5. Package imported as local draft or fork.
6. Reviewer optionally approves for tenant-wide use.
```

## UI blueprint inside MikeOSS

Add a new top-level **Library** area with five tabs:

- **Browse**: prompts, workflows, examples.
- **My Drafts**: promoted but not yet approved items.
- **Evaluations**: benchmark history and failures.
- **Publish Queue**: redaction and review status.
- **Exchange**: browse public packages and install/fork them.

Key screens:

- Item detail page with revision timeline, linked workflows/examples, evaluation history, and usage count.
- Example editor with side-by-side sanitized input, gold output, and rubric editor.
- Publication review screen showing sensitivity report, placeholder substitutions, and final manifest preview.
- Exchange package page with install button, changelog, signature info, and publisher trust badge.

## CLI blueprint

A terminal-first user should be able to operate the service entirely through a CLI wrapper.

```bash
mikectl library create prompt --title "Change of Control Review" --from-chat run_123
mikectl library approve lib_123
mikectl library eval lib_123 --model openai/gpt-5
mikectl publish prepare lib_123 --type example
mikectl publish review cand_456
mikectl publish send cand_456 --registry https://exchange.mikeoss.org
mikectl exchange search "change of control" --practice-area finance
mikectl exchange install pkg_abc123
mikectl exchange fork pkg_abc123 --title "Internal NY finance variant"
```

This aligns with a documentation-driven, API-first workflow and makes the service easier to automate in enterprise scripts and local orchestration pipelines.[cite:44][cite:42]

## Suggested implementation phases

### Phase 1: Local Library MVP

- Add SQLite schema and FTS5 index.
- Implement CRUD for prompts/examples/workflows.
- Add promotion from prior chat/workflow runs.
- Add revision history and approvals.
- Add local search and filters.

### Phase 2: Gold-standard examples

- Add rubric editor and evaluation runs.
- Add example comparison UI and pass/fail state.
- Add automated warning/deprecation workflow on repeated failures.

### Phase 3: Publication pipeline

- Add sensitivity scanning and placeholder transformer.
- Add publication candidates and audit log.
- Add manifest builder and signer.
- Add reviewer queue.

### Phase 4: Global exchange service

- Build registry API and package pages.
- Add moderation console and publisher verification.
- Add install/fork workflow from MikeOSS.
- Add ratings, telemetry, and update notifications.

### Phase 5: Federation and consortium spaces

- Add invite-only communities for firms, departments, or bar associations.
- Add package trust policies per tenant.
- Add optional mirrored private registries.

## Opinionated recommendations

Several choices will make the implementation safer and easier to scale.

- Use **SQLite only for the local MikeOSS Library**, not the public worldwide exchange.
- Treat every example as a **versioned executable fixture** with a rubric.
- Publish by **copy and transform**, never by direct reference to local matter artifacts.
- Make **forking the default install behavior** so imported assets remain governable locally.
- Require **reviewer approval** before any example becomes tenant-approved or publicly shareable.
- Sign manifests with **Ed25519** and verify at install time.
- Expose the whole system through **clean JSON APIs and CLI commands** rather than hiding critical functions in UI-only flows.[cite:44]

## Minimal Express + SQLite service decomposition

A clean code layout for MikeOSS could be:

```text
server/
  modules/
    library/
      library.routes.ts
      library.service.ts
      library.repo.ts
      library.search.ts
      library.schemas.ts
    evaluation/
      evaluation.routes.ts
      evaluation.service.ts
    publication/
      publication.routes.ts
      redaction.service.ts
      manifest.service.ts
      signing.service.ts
    exchange/
      exchange.routes.ts
      exchange.client.ts
  db/
    migrations/
      001_library.sql
      002_evaluation.sql
      003_publication.sql
```

If MikeOSS already uses a monorepo with Next.js and Express, this can be introduced as a modular slice without forcing a full rewrite.[cite:50][cite:51]

## Final design decision

The best conceptual model is: **Library = local institutional memory**, **Example = executable gold standard**, and **Exchange = signed sanitized package registry**. That gives MikeOSS the Mike-style reuse benefits of prompts and examples inside the tenant while also enabling a genuinely global open sharing layer that respects confidentiality, provenance, and local governance.[cite:52][cite:11][cite:50]
