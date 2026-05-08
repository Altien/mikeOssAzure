# Issue 026 — Surface Silent Frontend Fallbacks in Chat Flow

## Goal

Stop silently swallowing errors and silently redirecting in the chat-create + chat-load flow. Two specific spots are hiding real failures, costing real debugging time.

## Context

During the AOAI streaming bug debug (chats `840eb69e-…` and `7ee302b4-…`, root cause: `OPENAI_BASE_URL` leaking into the AzureOpenAI client and throwing `baseURL and endpoint are mutually exclusive`), the user-visible symptom was "I submit a question, page flashes, I'm back on the Assistant page with the input cleared, no error." That symptom was caused by the *frontend's* silent fallbacks, not the backend bug — even though the backend was throwing a clear, named error from the moment the very first AOAI chat was attempted.

Two specific places hid the real failure:

1. **`frontend/src/app/contexts/ChatHistoryContext.tsx:118`** — `saveChat` wraps `createChat()` in `try { … } catch { return null }`. Any HTTP error becomes `null` with no surfacing. The caller (`useAssistantChat.handleNewChat`) sees `null`, returns `null`, and the page does nothing.

2. **`frontend/src/app/(pages)/assistant/chat/[id]/AssistantChatClient.tsx:35-43`** — when a chat page loads and `getChat(id)` either returns zero messages OR throws, the page does `router.replace("/assistant")` with no UI feedback. So if the auto-send call fails (e.g., the backend 500'd), the user sees a brief flash and is back on the empty Assistant page with no clue what happened.

Together these turned an obvious server-side error into a 4-cycle debug chase that only resolved by reading backend logs directly.

## What to build

### 1. `saveChat` should surface the error

- Replace the silent `catch { return null }` with an error state that propagates back to the caller.
- The caller (currently `useAssistantChat.handleNewChat`) should set a UI error (toast, banner, or inline message under the input) instead of silently doing nothing.
- The error message should at minimum echo the HTTP status and the response body's `detail` field (the backend already emits structured `{ detail: string }`).

### 2. `AssistantChatClient` should not silent-redirect

- If `getChat(id)` throws: render the error state on the chat page itself, with a "Back to Assistant" link. Do not `router.replace`.
- If `getChat(id)` returns zero messages: this is genuinely the "stale empty chat" case. Either render an empty-chat UI with a "Start new chat" button, or — if the redirect is genuinely the right product behavior — surface a toast first ("This chat is empty, returning you to the Assistant") so the user understands what happened.

### 3. Audit the rest of the chat flow for similar patterns

- `streamChat` errors: confirm they propagate to the user (handler in `useAssistantChat.handleChat` already does this — just verify under network failure / 500).
- Other places using `try { … } catch { return null }` over fetch calls — check `mikeApi.ts` and the contexts.

## Acceptance criteria

- [ ] When `createChat` returns a non-2xx, the user sees a visible error message with the backend `detail`.
- [ ] When `getChat(id)` throws, the user sees an error on the chat page (not a silent redirect).
- [ ] When `getChat(id)` returns empty, the user sees explicit feedback (empty-state UI or a redirect-with-toast), not a silent redirect.
- [ ] Manually verified by injecting a 500 response from the backend (e.g., via DevTools network override) — error surfaces, no flash-and-bounce.

## Out of scope

- Reworking the auth-redirect path on 401 — `bounceIfUnauthorized` should keep its current behavior (redirect to /login). This issue is about *non-auth* errors being silenced.
- Changing the backend error response shape.

## Related

- Issue 023 (install configurator) — surfaces the same kind of "operator can't tell what failed" problem; lessons here apply.
- Issue 027 (MSAL silent token refresh) — fixes the upstream cause of some of the 401s, but doesn't remove the need to surface non-401 errors.
