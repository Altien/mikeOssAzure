# SQLite + Committee Model Migration Handoff

Date: 2026-07-11
Updated: 2026-07-21

## Summary

This project was migrated away from the prior hosted database/storage references to local SQLite-backed application data, SQLite-backed file byte storage, local bearer-token auth, and configurable model orchestration.

The model orchestration system supports:

- built-in cloud providers: OpenAI, Anthropic Claude, Gemini
- OpenAI-compatible local/cloud endpoints: Ollama, LM Studio, vLLM, LocalAI, OpenRouter, OpenArc
- committee models where members run sequentially in list order, then a chair model synthesizes the final answer
- local agent objects with per-agent `systemPrompt`

No prior hosted database references were left in the source/docs/package files at the last check.

## Important Files

- `backend/src/lib/sqlite.ts`
  - SQLite compatibility layer replacing the old hosted database client usage.
  - Dynamic table/column creation.
  - Query builder methods used by the app: `select`, `insert`, `update`, `delete`, `upsert`, `eq`, `neq`, `gt`, `in`, `is`, `not`, `filter`, `order`, `limit`, `range`, `single`, `maybeSingle`.
  - `upsert` honors `ignoreDuplicates` and no longer rewrites `created_at` on conflict.
  - `order(column, { numeric: true })` emits `cast(col as numeric)` for TEXT-affinity numeric columns.
  - `filter(col, "cs", …)` escapes LIKE wildcards (`\`, `%`, `_`) and uses `escape '\'`.
  - Local auth/session helpers. `local_sessions` has an `mfa_verified` column (auto-migrated); `createSession(userId, mfaVerified)`, `findSession` returns `{ userId, mfaVerified }`, `markSessionMfaVerified(token)` elevates a session.
  - Custom RPC shim for old database functions:
    - `get_projects_overview`
    - `get_chats_overview`
    - `get_tabular_reviews_overview`
    - `get_workflows_overview`

- `backend/src/lib/storage.ts`
  - Stores file bytes in SQLite using `SQLITE_STORAGE_PATH`.
  - Replaces the earlier remote-object-storage style.
  - `getSignedUrl(key, expiresIn)` now embeds a real expiry in the signed download token.

- `backend/src/lib/downloadTokens.ts`
  - HMAC-signed download tokens. `signDownload(path, filename, expiresInSeconds?)` embeds an optional expiry; `buildDownloadUrl` (chat cards/permalinks) stays non-expiring because `/download/:token` re-checks document access on every request.

- `backend/src/lib/mfa.ts`
  - Local TOTP (RFC 6238) MFA: factor CRUD, AES-256-GCM encrypted secrets (key derived from `USER_API_KEYS_ENCRYPTION_SECRET`), stateless HMAC challenges, QR codes via the `qrcode` package.
  - Factors live in `user_mfa_factors` (auto-created).

- `backend/src/middleware/auth.ts`
  - Local bearer-token auth backed by SQLite sessions.
  - Enforces MFA assurance: sessions with `mfa_verified = 0` (aal1) are rejected with 403 `mfa_verification_required` except for `/mfa/*` endpoints and `GET /profile`.
  - `requireMfaIfEnrolled` now rejects aal1 sessions on the routes that use it.

- `backend/src/routes/user.ts`
  - Local auth routes:
    - `POST /user/auth/signup` (validates email format, rate-limited)
    - `POST /user/auth/login` (returns `mfaRequired`; creates aal1 session when MFA is enforced)
    - `GET /user/auth/session`
    - `POST /user/auth/logout`
    - `PATCH /user/auth/email` (validates format, 409 on duplicates)
  - MFA routes: `GET /user/mfa/status`, `POST /user/mfa/enroll`, `POST /user/mfa/challenge`, `POST /user/mfa/verify`, `POST /user/mfa/unenroll` (unenroll requires aal2; removing the last verified factor clears `mfa_on_login`).
  - `POST /user/support` stores feedback in `support_feedback` and emails it via Resend when `RESEND_API_KEY` + `SUPPORT_INBOX_EMAIL` are set.

- `backend/src/index.ts`
  - Global Express error-handling middleware plus a `process.on("unhandledRejection")` logger (Express 4 does not catch async handler rejections).
  - Dedicated stricter rate limiter on `/user(s)/auth/signup|login` (`RATE_LIMIT_AUTH_*`).

- `frontend/src/app/lib/auth.ts`
  - Frontend local auth helper replacing the previous hosted auth client usage.
  - Stores token in `localStorage` under `mike_auth_token`.
  - Dispatches `mike-auth-change`.
  - `getCurrentUser()` only clears the token on 401/403 or an explicit null session — transient network failures no longer log the user out.
  - `localAuth.mfa` is now implemented against the backend TOTP endpoints (no longer stubs).

- `backend/src/lib/llm/registry.ts`
  - Loads `MIKE_MODEL_CONFIG_JSON`.
  - Exposes configured model and committee summaries.

- `backend/src/lib/llm/openaiCompatible.ts`
  - Calls OpenAI-compatible `/chat/completions` endpoints.
  - Uses `apiModel || modelName || id` as the model name sent to the endpoint.
  - 120s `AbortSignal.timeout` on requests.

- `backend/src/lib/llm/committee.ts`
  - Committee execution.
  - Members run sequentially in list order.
  - Chair runs after all member outputs are collected.
  - Direct committee self-reference is rejected; indirect cycles (A→B→A) are rejected via a `committeeStack` cycle guard.
  - Committee mode in chat drops tools and answers directly (with a system-prompt notice) instead of throwing.

- `docs/model-orchestration.md`
  - Main setup guide for local OpenAI-compatible models, committees, and local agents.

## Environment Variables

Backend:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string

SQLITE_DB_PATH=./data/mike.sqlite
SQLITE_STORAGE_PATH=./data/mike-files.sqlite

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret

MIKE_MODEL_CONFIG_JSON='...'
```

Frontend:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

## Committee Configuration Example

This example has all committee members local, each making sequential calls to a B70 model served by OpenArc. The chair is OpenRouter.

```bash
OPENROUTER_API_KEY='your-openrouter-key'

MIKE_MODEL_CONFIG_JSON='{
  "models": [
    {
      "id": "local-b70-openarc",
      "label": "Local B70 via OpenArc",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "b70",
      "baseUrl": "http://localhost:8000/v1"
    },
    {
      "id": "openrouter-chair",
      "label": "OpenRouter Chair",
      "provider": "openai-compatible",
      "location": "cloud",
      "apiModel": "openai/gpt-4.1",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  ],
  "committees": [
    {
      "id": "local-b70-openrouter-committee",
      "label": "Local B70 Committee + OpenRouter Chair",
      "members": [
        {
          "id": "issue-spotter",
          "label": "Issue Spotter",
          "model": "local-b70-openarc",
          "systemPrompt": "Act as a legal issue spotter. Identify factual gaps, ambiguity, threshold legal issues, and questions that must be resolved before relying on the answer."
        },
        {
          "id": "contract-reviewer",
          "label": "Contract Reviewer",
          "model": "local-b70-openarc",
          "systemPrompt": "Act as a contract reviewer. Focus on defined terms, obligations, deadlines, conditions, remedies, termination rights, and drafting inconsistencies."
        },
        {
          "id": "risk-counsel",
          "label": "Risk Counsel",
          "model": "local-b70-openarc",
          "systemPrompt": "Act as skeptical risk counsel. Challenge unsupported assumptions, flag missing authority, identify legal and commercial risk, and call out where the answer overstates certainty."
        },
        {
          "id": "citation-auditor",
          "label": "Citation Auditor",
          "model": "local-b70-openarc",
          "systemPrompt": "Act as a citation and evidence auditor. Check whether conclusions are supported by provided documents or cited authority. Do not invent citations."
        }
      ],
      "chair": "openrouter-chair"
    }
  ]
}'
```

Notes:

- `models[].id` is Mike's internal model id and the UI-facing selection id.
- `models[].apiModel` is the model name sent to the OpenAI-compatible server.
- `models[].baseUrl` should include `/v1`.
- Committee `members` can be strings or agent objects.
- Committee members run one after another in list order.
- The `chair` must be a model id, not the committee's own id.
- Committee models currently do not support tool-calling chat/document tools; use an individual model for tool use.

## SQLite Compatibility Notes

The SQLite adapter intentionally emulates the subset of query-builder behavior used by this app. It is not a complete general-purpose database client clone.

Important behaviors:

- Tables are created lazily.
- Columns are added lazily based on selected/inserted/filtered fields.
- Non-scalar values are JSON-encoded.
- JSON arrays are decoded on read.
- Boolean-like profile columns are normalized:
  - `mfa_on_login`
  - `legal_research_us`
- `filter("shared_with", "cs", JSON.stringify([email]))` is implemented as a JSON-array string match with LIKE wildcards escaped (`escape '\'`).
- `single()` returns an error for zero rows.
- `maybeSingle()` returns `null` for zero rows.
- `rpc()` supports the four overview functions listed above.

## Bugs Found And Fixed During Deep-Dive Passes

- Profile email update did not execute reliably because it used a promise-like query builder without an explicit await path. It now performs a direct SQL update.
- SQLite boolean decoding returned `"1.0"` / `"0.0"` for dynamically added boolean-like columns. Decoder now handles those.
- Frontend stale local auth tokens could leave auth loading in a bad state. `getCurrentUser()` now clears invalid tokens and returns `null`.
- OpenAI-compatible local runtimes often require a model name different from Mike's logical id. Added `apiModel` / `modelName`.
- Committee self-reference could recurse. Direct self-reference as chair or member is rejected.
- MCP connector tool discovery used embedded join syntax. It now uses explicit SQLite queries.
- SQLite `.not(...)` support was too loose. It now supports the used shapes safely.
- Overview RPC shim was initially too shallow. It now mirrors key old SQL function behavior for visibility, ordering, filters, limits, counts, and owner flags.
- Committee member execution was initially parallel. It is now sequential in list order.

## Bugs Found And Fixed In The 2026-07-21 Pass

Backend (security/data integrity):

- `requireAuth` wiped the profile on every request: `ensureLocalProfile` upserted full defaults (tier Free, 0 credits, `mfa_on_login` 0) over the existing row. It is now insert-only-if-missing.
- Cross-tenant access via LIKE wildcards: the `cs` filter used for `shared_with` matching never escaped `%`/`_`, and signup accepted any string as an email. Wildcards are now escaped (`escape '\'`) and signup/email-change validate email format.
- Read-only workflow shares were editable: `allow_edit` round-trips as the truthy string `"0"` from the SQLite adapter. Coerced explicitly (`=== true || === 1 || === "1"`). Same bug fixed for MCP `requires_confirmation` and connector/tool `enabled` summaries (which also made every tool-enable attempt throw).
- `version_number` ordering broke after V9 (TEXT affinity) and `nextVersionNumber` did string concatenation (`"9" + 1 = "91"`). Ordering now uses `cast(... as numeric)` and values are coerced with `Number(...)`.
- Account/chat/review deletion left orphaned rows (chat_messages, tabular cells + review chat messages, document_versions/edits rows, user_api_keys, MCP connectors/tools/OAuth tokens/states/audit logs, user_profiles, support_feedback). Full cascades added in `userDataCleanup.ts`, single-chat/single-review deletes, and `deleteUserMcpConnector`.
- Shared (non-owner) project members could delete folders (+contained docs), edit folders, and rename documents; review members could remove documents (deleting cells) and clear cells. Destructive operations are now owner-only; folder delete removes the whole subtree.
- Express 4 never caught async handler rejections (duplicate-email PATCH, missing `messages`, non-string `title`, non-array `columns_config` could crash/hang). Added a global error middleware, an `unhandledRejection` logger, and input validation on those routes.
- Committee models always failed in chat (tools were always passed) and nested committees could recurse. Tools are now dropped with a system-prompt notice, and a `committeeStack` cycle guard rejects indirect cycles.
- MCP SSRF guard was vulnerable to DNS rebinding (TOCTOU between DNS validation and fetch). `guardedFetch` now pins the pre-validated addresses via an undici `Agent` with a custom `lookup`; all OAuth metadata/token/registration fetches go through it.
- Download tokens never expired. `signDownload` supports an optional expiry and `getSignedUrl` honors `expiresIn`. Chat-card/permalink tokens stay non-expiring because `/download/:token` re-checks document access per request.
- `courtlistener_search_case_law` was fully implemented in the dispatcher but missing from `COURTLISTENER_TOOLS`, so the model could never call it. Schema added and the system prompt mentions it.
- `verifyPassword` threw on malformed stored hashes (500 instead of 401).
- `ignoreDuplicates` upsert option was silently ignored; upsert-on-conflict also rewrote `created_at`.
- OpenAI-compatible fetch had no timeout (hung local servers hung title/committee calls).
- Login/signup had no dedicated rate limit; added a stricter `RATE_LIMIT_AUTH_*` limiter.
- Local TOTP MFA is now implemented end-to-end (see `backend/src/lib/mfa.ts` and the `/user/mfa/*` routes); it was previously dead code with stubbed frontend methods, and enabling `mfa_on_login` would have locked users out.

Frontend:

- Navigating between chats kept stale state (wrong chat received new messages) because App Router reuses the page component on param change. Both chat pages now remount on id change via a `key` wrapper.
- The support form posted to a non-existent `/api/support`. It now calls `POST /user/support` via `submitSupportFeedback`.
- `useSmoothedReveal` permanently truncated the tail of assistant messages when streaming ended mid-reveal.
- `useSelectedModel` validated against the static built-in model list, silently reverting server-configured local/committee models to the default.
- `getCurrentUser()` discarded valid tokens on any network/5xx error.
- `TRChatPanel` swallowed HTTP errors on stream start (no `response.ok` check).
- `AuthContext` read `user.new_email` but the backend returns `pendingEmail`.
- Sidebar chat list was wiped on any transient `listChats` failure.
- Signup success screen could be raced away by the auth-redirect effect.
- Sidebar-open persistence wrote the mobile value with a desktop-only dependency.
- All 24 pre-existing ESLint errors fixed (React `set-state-in-effect` patterns converted to adjust-during-render or async callbacks, `no-explicit-any` casts removed, unescaped entities, use-before-declare). Lint is now 0 errors / 35 warnings (pre-existing unused vars).

## Validation Already Run

Passing:

```bash
cd backend
npm run build
```

Passing:

```bash
cd frontend
npx tsc --noEmit
```

Passing targeted lint:

```bash
cd frontend
npx eslint src/app/lib/auth.ts
```

Passing compiled-code smoke coverage:

- local user creation
- password verification
- session creation/lookup
- profile email update
- profile boolean decoding
- shared-with filtering
- SQLite file upload/download/list
- MCP connector tool loading via SQLite queries
- OpenAI-compatible `apiModel` forwarding
- committee self-reference rejection
- sequential committee execution order
- overview RPC behavior for projects, chats, tabular reviews, workflows

Passing live HTTP smoke against compiled backend on port `3331`:

- signup
- session lookup
- profile fetch
- model summary fetch
- logout

## Validation Run In The 2026-07-21 Pass

Passing:

```bash
cd backend && npm run build
cd frontend && npx tsc --noEmit
cd frontend && npm run lint   # 0 errors, 35 warnings
cd frontend && npm run build  # Next/Turbopack production build
```

Passing compiled-code smoke:

- profile defaults no longer overwrite existing rows on repeated `ensureLocalProfile` calls
- `cs` filter: wildcard emails match nothing, legit and underscore emails match exactly
- TOTP MFA: enroll, duplicate-name rejection, challenge, correct/wrong/tampered-code verification, session aal1→aal2 elevation, unenroll
- committee cycle rejection (A→B→A) and tool-passing no longer throwing upfront

Passing live HTTP smoke against compiled backend:

- signup, invalid-email rejection, MFA enroll/challenge/verify, `mfa_on_login` toggle
- login returns `mfaRequired`; aal1 session blocked from `/chat` with 403 `mfa_verification_required`; aal1 allowed on `GET /user/profile` and `/user/mfa/status`; post-verify session reaches `/chat`
- `POST /user/support` accepts feedback

## Ironclad CLM Integration (2026-07-21)

Instance-level integration with the Ironclad public API so Ironclad contracts
can be used as data sources.

Backend:

- `backend/src/lib/ironclad.ts`
  - Env config: `IRONCLAD_API_KEY` (required), `IRONCLAD_BASE_URL` (default
    `https://na1.ironcladapp.com`), `IRONCLAD_AS_USER_EMAIL` (optional actor
    override for client-credentials tokens; otherwise the signed-in Mike
    user's email is sent as `x-as-user-email`).
  - `listIroncladRecords` (search/sort/pagination), `getIroncladRecord`
    (metadata + attachment keys, defensive about attachment payload shapes),
    `downloadIroncladAttachment` (100 MB cap, filename from
    Content-Disposition).
- `backend/src/lib/documentIngest.ts`
  - `createDocumentFromBytes` — the ingestion pipeline extracted from
    `handleDocumentUpload` (storage key, Office→PDF rendition, V1
    `document_versions`, `current_version_id`). Shared by the multer upload
    routes and Ironclad imports (`source: "ironclad"`).
- `backend/src/routes/ironclad.ts` mounted at `/integrations/ironclad`:
  - `GET /status` → `{ configured }`
  - `GET /records` (search/page/pageSize/sortField/sortDirection)
  - `GET /records/:recordId`
  - `POST /import` `{ recordId, attachmentKey, projectId? }` — downloads
    server-to-server and ingests; rate-limited like uploads.
- Chat tools (`backend/src/lib/chat/tools/ironcladTools.ts`):
  `ironclad_search_contracts`, `ironclad_get_contract`,
  `ironclad_import_contract` — registered in the base tool set only when
  `isIroncladConfigured()`; the import tool ingests into the current project
  (or standalone) and registers the new doc in the turn's doc index so the
  model can read it immediately. `IRONCLAD_SYSTEM_PROMPT` is spliced into
  `buildSystemPrompt` when configured.
- `document_versions.source` CHECK extended with `'ironclad'`
  (`schema.sql` + `migrations/20260721_01_ironclad_version_source.sql`).

Frontend:

- `mikeApi.ts`: `getIroncladStatus`, `searchIroncladRecords`,
  `getIroncladRecord`, `importIroncladRecord`.
- `components/modals/IroncladImportModal.tsx`: search records → pick record
  → pick attachment → import. Wired into `AddDocumentsModal` (the shared
  document picker used by projects, chat, and tabular review) via an
  "Import from Ironclad" header button.
- Chat rendering: Ironclad SSE events handled in `useAssistantChat` and
  rendered in `AssistantMessage` via `CourtListenerBlock`; tool labels in
  `eventUtils.ts`.

Validation: mock-Ironclad HTTP smoke — status, record list (counterparty
hydration), record detail (attachment keys), import → document `ready` with
`source: ironclad`, `page_count` computed, bytes stored; normal upload path
re-verified after the ingest refactor.

Known gaps: imports are snapshots (re-import to refresh); the tabular-review
chat SSE parser ignores Ironclad event types (tool still works; no dedicated
activity rendering there).

## Known Residual Issues

`frontend npm run build` (Next/Turbopack) now completes successfully as of 2026-07-21 (it previously appeared to hang at `Creating an optimized production build ...`).

35 lint warnings remain, all pre-existing unused variables (mostly `node` params in react-markdown component maps) and are cosmetic.

The SQLite compatibility adapter is pragmatic and app-specific. If another tool expands app behavior, it should verify any new query methods before assuming they work.

`decode()` still auto-JSON-parses any string that looks like JSON (`"[1,2]"` titles come back as arrays) — low risk, needs a per-column JSON registry to fix cleanly.

MCP `validateRemoteMcpUrl` still blocks private/link-local IPs at validation time only for URLs opened in the user's browser (OAuth authorization redirects) — server-side fetches are pinned, browser redirects are the user's own choice.

## Suggested Next Checks

1. Run end-to-end UI flows with a real local SQLite DB:
   - signup/login (+ MFA enroll, login verification, unenroll)
   - upload document
   - create project
   - create chat
   - create tabular review
   - save/open workflow

2. Test a real local OpenAI-compatible endpoint:
   - OpenArc B70 at `http://localhost:8000/v1`
   - Ollama at `http://localhost:11434/v1`

3. Test OpenRouter chair with a real key:
   - `OPENROUTER_API_KEY`
   - `baseUrl: "https://openrouter.ai/api/v1"`

4. Decide whether to keep deleted `bun.lock` files or regenerate them if Bun support is required.
