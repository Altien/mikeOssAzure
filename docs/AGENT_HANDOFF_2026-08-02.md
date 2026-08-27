# Agent Handoff — 2026-08-02

## Where things stand (read this first)

**Uncommitted, but implementation and verification are complete.** The
`ask_inputs` Gemini-key failure is fixed on both sides:

1. `ChatView.tsx` passes `model: selectedModel` in the
   `AskInputPopup.onSubmit` auto-send. Previously it sent `model: undefined`,
   which made the backend fall back to `gemini-3-flash-preview` and fail for
   users without a Gemini key.
2. `backend/src/lib/chat/streaming.ts` now uses
   `resolveUsableModel(model, DEFAULT_MAIN_MODEL, apiKeys)`. If the requested
   or default model lacks a usable key, the backend selects an available
   configured/built-in model. With the current backend environment, an omitted
   model resolves to `kimi-k3`.
3. Added three regression tests for usable-model resolution in
   `backend/src/lib/__tests__/llmModels.test.ts`.

Verification is green: backend TypeScript, 401 backend tests, frontend
TypeScript, 61 frontend tests, and frontend lint. A conclusive backend restart
was not possible inside the managed sandbox: port 3001 appeared occupied while
the sandbox could neither see nor reach the owning process. Restart it from a
normal terminal before retrying the redline flow (see "Running locally").

## Running locally

- Backend: `cd backend && npm run dev` (tsx watch, port 3001). **It does NOT
  reliably auto-reload; restart after edits.** Start detached with
  `(setsid nohup npm run dev > /tmp/mike-backend.log 2>&1 < /dev/null &)`.
  Kill with `pkill -f "[t]sx watch src/index.ts"` — the `[t]` matters,
  `pkill -f "tsx watch"` self-matches and kills your own shell.
- Frontend: `cd frontend && npm run dev` (Next, port 3000).
- Logs: `/tmp/mike-backend.log`, `/tmp/mike-frontend.log`.
- Test commands: backend `npm test` (vitest, 401 passing at last full run),
  `npx tsc --noEmit`; frontend `npm test` (61 passing), `npm run lint`,
  `npx tsc --noEmit`. Several backend files fail `prettier --check` at
  baseline (pre-existing — do not bulk-format).
- Backend env: `backend/.env`. I added `LLM_REQUEST_TIMEOUT_MS=600000`
  (default LLM timeout was a hardcoded 120s in
  `backend/src/lib/llm/openaiCompatible.ts` — now env-overridable via
  `requestTimeoutMs()`).

## What happened today, in order

### 1. LLM-council review (context)
The user had me run the local LLM council (llm-council backend on :8001,
OpenArc on :8000) over the ~20 largest source files in this repo, split into
18 ~100KB batches. Results: `/tmp/council-final-all.txt` (chairman syntheses),
`/tmp/council-resp*.json` (raw). Many findings were **false positives** —
see the "rejected claims" list in the chat and below.

### 2. Verified + fixed council findings (all committed? NO — uncommitted)
All changes below are **uncommitted in the working tree**. Baseline was green
(396 backend / 61 frontend tests) and everything was re-verified green after.

Fixes applied:
- `backend/src/routes/user.ts`: signup/login/PATCH-email now trim email at
  extraction (was validating trimmed but storing/looking up untrimmed →
  duplicate accounts). Credit reset made conditional/atomic
  (`.lt("credits_reset_date", now)`). `/support` email send is now
  fire-and-forget (was blocking the 204).
- `backend/src/routes/tabular.ts`: `/generate` doc fan-out capped at 4
  concurrent via new `mapWithConcurrency` helper (was unbounded
  `Promise.all` over downloads+LLM calls).
- `backend/src/lib/chat/tools/documentOps.ts`: `generateDocx` outer catch now
  discards the uploaded file on thrown errors (orphan-file hardening).
- `backend/src/lib/chat/tools/toolDispatcher.ts`: swallowed tool-arg
  `JSON.parse` failures now logged via `devLog`.
- `backend/src/lib/docxTrackedChanges.ts`: `cloneNode` uses
  `structuredClone`.
- `backend/src/lib/playbooks.ts`: `parseModelJson` fallback now tries
  `jsonrepair` (already a dep).
- `frontend/src/app/lib/mikeApi.ts`: `getChat`/`mapTRMessages` preserve
  assistant string content (was collapsing to `""`).
- `frontend/src/app/components/documents/DocTable.tsx`:
  `handleCreateFolder` try/catch + optimistic rollback; `wouldCreateCycle`
  uses a memoized parent map.
- `frontend/src/app/components/tabular/TRChatPanel.tsx`: unmount cleanup
  aborts stream + clears drip interval.
- `frontend/.../chat/[chatId]/page.tsx`: `key={msg.id ?? i}`; stale-fetch
  guards on both `getProject` effects; move doc/folder optimistic updates
  revert via refetch on failure.
- `frontend/src/app/hooks/useAssistantChat.ts`: `updateMatchingEvent` uses
  allocation-free reverse loop.
- New test: `backend/src/__tests__/integration/user.auth.sqlite.test.ts`
  (email trim regression; 2 tests).

Council claims **verified FALSE** (do not "fix" these): legalMonitors
`mapWithConcurrency` (correct pool pattern), `source_types` corruption
(sqlite `encode()` JSON-stringifies), tabular.ts JSON.parse-outside-try,
sqlite.ts RPC error swallowing, sqlite conflict-SELECT "hotspot" (in-process
db), toolDispatcher mcp_/generate_* crashes (callees catch internally),
docxTrackedChanges duplication + whitespace-drift (wrapper childIndex design
handles it), OAuth popup XSS, TRChatPanel abort/deps, TabularReviewView
optimistic updates (already pessimistic), useAssistantChat citationStatus
(intentional UX).

### 3. Redline-on-PDF feature (the user's real goal)
User redlined `Cooley SaaS Agreement ACC Form.pdf`; model only emitted prose
because `edit_document` was docx-only.

- `documentOps.ts`: new `createEditableDocxFromPdf()` — extracts PDF text,
  builds an editable `.docx`, registers it as a new document
  ("<name> (Editable).docx"), original PDF untouched. Full cleanup on
  failure.
- `toolDispatcher.ts` `edit_document` branch: accepts PDFs; first edit in a
  turn converts, subsequent edits reuse the copy (via extended
  `TurnEditState` value with optional `documentId` field in documentOps.ts).
- `toolSchemas.ts`: `edit_document` description now says PDFs auto-convert.
- Verified end-to-end against the real PDF: extraction → docx →
  `applyTrackedEdits` → real `w:ins`/`w:del` markup in output.

### 4. Layout-preserving PDF extraction (user asked for PDF-faithful text)
`extractPdfText` in documentOps.ts rewritten: line grouping by
y-coords/hasEOL, gap-based word joining (fixes "constitut e"), paragraph
breaks, margin-relative indentation. New helper `layoutPageText()`.
Before/after on the real PDF verified — output now mirrors the PDF layout
(numbered clauses, hanging indents, centered title). This also improves
`read_document` anchors and the editable-copy fidelity.

### 5. Ask-for-Word flow (user asked)
`prompts.ts` DOCUMENT EDITING section: model must call `ask_inputs` first
for PDF redlines — documents item requesting the original .docx + choice
fallback ("No Word version — work from the PDF text"). Upload path needed no
frontend changes (AddDocumentsModal already supports uploads; uploaded docx
becomes a normal chat doc). **This is the flow that exposed the Gemini bug
below** — the popup's auto-submit dropped the model.

### 6. Gemini API key error (FIXED + VERIFIED)
Root cause: `ChatView.tsx` ask_inputs auto-submit sent `model: undefined`;
backend `resolveModel(undefined, DEFAULT_MAIN_MODEL)` →
`gemini-3-flash-preview` → no Gemini key → AssistantStreamError.
Frontend now carries the selected model through the popup. Backend streaming
now uses `resolveUsableModel`, so it falls back to a model with a configured
user/env key rather than blindly using the Gemini default. Three focused model
resolution tests were added; the full verification matrix is green (counts at
the top of this document).

## Assistant response-performance review (2026-08-02)

The user reported pauses while using Assistant. This was a read-only review;
**no performance fixes have been implemented yet.** Timing and event-size
metadata were inspected without reading message text.

### Measured evidence

- A recent large-document analysis turn took about **569.5 seconds (9m 30s)**
  and stored approximately **94k characters of reasoning events**.
- The PDF redline turn took about **635.6 seconds (10m 36s)** and stored
  approximately **77k characters of reasoning events**, plus three
  `doc_edited` events and four `doc_find` events.
- The first generated/editable document version in that redline was not
  written until about **9m 16s after submission**. Most of the delay therefore
  occurred during model reasoning/tool planning and repeated tool/model
  iterations, not the final database write.
- Earlier document turns in the same chat took roughly 113–142 seconds.

### Ranked causes

1. **High-effort reasoning is always on (primary cause).**
   `backend/src/lib/llm/registry.ts` hardcodes
   `reasoning_effort: "high"` for both Kimi models, and
   `backend/src/lib/chat/streaming.ts` passes `enableThinking: true` on every
   Assistant turn. The streaming Kimi/OpenAI-compatible request has no
   `max_tokens` ceiling. This permits extremely long reasoning before a tool
   call or visible answer.

2. **Document work causes multiple full model passes.** A redline commonly
   becomes read → model → edit → model → verify/search → model → final answer.
   `runLLMStream` permits up to 10 iterations, and each iteration resends the
   growing message/tool context.

3. **Repeated document searches redo whole-file work.** Every
   `find_in_document` call invokes `readDocumentContent()` again, causing
   another active-version lookup, file download, extraction, and full-text
   normalization. The recent redline did this four times. There is no
   per-turn extracted-text/byte cache.

4. **Tool calls are sequential.** `runToolCalls()` uses one `for ... of` loop
   and awaits each tool. Independent reads/searches/connectors therefore wait
   for one another. `fetch_documents` also reads its requested documents
   sequentially.

5. **Streaming can make the frontend janky.** Every content/reasoning delta
   clones event/message arrays and triggers React state. `ReasoningBlock`
   reparses the entire accumulated reasoning as Markdown and measures its DOM
   height whenever `text` changes. `ChatView` rerenders all historical
   messages on each delta. With 77k–94k reasoning characters this can appear
   frozen even while the backend is streaming.

6. **Substantial serial work happens before the first SSE response.** Both
   chat routes perform feature checks, chat access/persistence, document
   context building, history enrichment, model/API-key loading, and workflow
   loading before setting/flushing SSE headers. `runLLMStream` then repeats the
   user-feature lookup and loads Gmail/MCP tool metadata before calling the
   model. A normal frontend submission initially renders an empty assistant
   message, so this phase looks like a blank pause.

7. **The fixed prompt/tool payload is large.** The default system prompt plus
   14 normal/research/workflow tool schemas is approximately **24,642
   characters** before chat history, project tools, document names, or MCP
   tools. This payload is paid again on model iterations. Project tools add
   roughly another 1.9k characters.

8. **Conversation and project context grow without tight bounds.** The browser
   sends the full message history. General chat also scans all prior assistant
   event payloads to recover generated/edited document IDs; project chat loads
   every ready project document and folder into context each turn.

9. **Local SQLite has no secondary indexes for core dynamic tables.** The
   current database has only 96 chat messages, so this is not today's
   multi-minute cause. However, `chat_messages.chat_id`, document/project/user
   filters, document versions, workflows, and similar queries are table scans.
   The SQLite adapter uses synchronous `node:sqlite`, so these scans will block
   the server event loop as data grows.

10. **The frontend ignores the `[DONE]` event.** `useAssistantChat.ts` waits
    for the HTTP body to close. The backend emits `[DONE]` and then persists
    the possibly large assistant event payload before ending the response,
    creating a smaller end-of-response pause.

### Recommended implementation order

1. Add **Fast / Thorough** reasoning modes; stop making `high` the default and
   add a safe model-output ceiling. Preserve high effort as an explicit choice
   for difficult redlines/research.
2. Batch frontend streaming updates (for example, 30–60 ms), render reasoning
   cheaply while streaming, lazy-mount collapsed historical reasoning, and
   memoize non-streaming messages.
3. Add a turn-scoped cache for downloaded document bytes and extracted text;
   reuse it for `read_document` and every `find_in_document` call.
4. Open SSE earlier and emit a `preparing` event; reuse the already-loaded
   feature flags and parallelize independent context/settings/workflow queries.
5. Send only relevant tools and bounded/summarized history on each model pass.
6. Add SQLite indexes for the core access paths and treat `[DONE]` as the
   frontend completion signal.

## Gemini reasoning-only response fix (2026-08-03)

A Gemini 3.5 Flash Assistant turn asking for recent Legal AI news reproduced a
distinct failure: it ran for about 61 seconds, used all 10 allowed model/tool
rounds, persisted eight reasoning blocks and 10 successful MCP tool events, but
persisted no content or citations. The only enabled MCP connectors were
specialized case-law/PACER and patent/trademark sources; there was no general
web or news source. Gemini repeatedly tried those tools, and `streamGemini`
silently treated iteration exhaustion as a successful empty response.

Implemented fixes:

- `backend/src/lib/llm/gemini.ts` now treats `maxIterations` as the maximum
  number of tool rounds and reserves one final request with tools disabled.
  That request must synthesize a visible answer from relevant results or state
  which source capability is missing.
- A thought-only Gemini completion now raises an explicit stream error instead
  of being persisted as a successful blank response.
- The Assistant system prompt now prohibits using case-law, PACER, statute,
  patent, or trademark tools as proxies for a general current-news search.
- `backend/src/lib/__tests__/gemini.test.ts` covers tool-round exhaustion,
  ordinary direct answers, and reasoning-only responses.

Verification after the change: backend TypeScript passed; all backend tests
passed (**415 passed, 13 skipped** across **51 passed, 2 skipped** files).

## Loose ends / watch items

- **Uncommitted everything.** `git status` shows modified files across
  backend/frontend plus new files. User has not asked for a commit.
- Kimi K3 document/redline turns are currently taking 9.5–10.6 minutes. This
  is now a measured performance issue, not merely a watch item; see the full
  performance review above. The 10-minute per-request timeout allows long
  provider iterations but is not itself the cause of the latency.
- `createEditableDocxFromPdf` builds a text-reconstructed docx — formatting
  won't match original layout; the ask-for-Word flow is the preferred path.
- Council raw outputs in /tmp are ephemeral; regenerate if needed.
- The llm-council/OpenArc servers (:8001/:8000) may still be running from
  this morning's review.
