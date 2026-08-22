import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordChatTurn } from "../lib/audit";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalChatId,
    parseOptionalModel,
    parseOptionalProjectId,
    createReservedAssistantMessageUpdater,
    openAssistantSse,
    reserveAssistantMessage,
    withoutEmptyAssistantReservations,
} from "../lib/chat";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { getSkillChatBindingMetadata } from "../altien/skills/runtime";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import { generateAssistantChatTitle } from "../lib/chatTitle";
import { sendInternalError } from "../lib/httpError";

export const chatRouter = Router();

// Adopted from upstream 44e868e (devLog, used by
// the abort-aware stream error path). Upstream 3f76761b centralized the
// request-body validators (parseChatMessages / parseOptional*) in
// lib/chat/requestValidation.ts; dev ADOPTS those validators. Upstream's
// AccessibleChat / getAccessibleChat / validateAccessibleProjectId helper
// block (404-on-inaccessible-chat semantics) remains rejected — dev's
// access checks live inline below and in lib/access.ts (an inaccessible
// chat_id silently starts a fresh chat; earlier sync decisions).
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : null;
    const offset =
        Number.isFinite(requestedOffset) && requestedOffset > 0
            ? requestedOffset
            : 0;

    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: userId,
        p_limit: limit,
        p_offset: offset,
    });
    if (error) return void sendInternalError(res, error);
    res.json(data ?? []);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const projectId = parsedProjectId.value.projectId;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? undefined })
        .select("id")
        .single();

    if (error) return void sendInternalError(res, error);
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(withoutEmptyAssistantReservations(messages ?? []), db);
    const skillBinding = await getSkillChatBindingMetadata({ chatId, db });
    res.json({ chat, messages: hydrated, skill_binding: skillBinding });
});

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string") versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId);

    if (error) return void sendInternalError(res, error);
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message: string = (req.body.message ?? "").trim();
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("id, user_id, project_id")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    // Title generation is cosmetic — the chat itself is already saved
    // and usable.  If the LLM call fails (no provider configured, AOAI
    // deployment unreachable, etc.) we fall back to the first ~60
    // chars of the message instead of failing the request.  Errors are
    // logged so a misconfiguration is still visible in the backend.
    let title = message.slice(0, 60);
    try {
        const { fast_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        title = await generateAssistantChatTitle({
            // Dev routes title generation through fast_model.
            model: fast_model,
            message,
            apiKeys: api_keys,
        });
    } catch (err) {
        // Upstream divergence (sync-log: 3a10943): upstream returns 500 when
        // the title LLM call fails; dev intentionally keeps the
        // message-prefix fallback title instead. safeErrorLog adopted so the
        // raw error (which can embed provider key material) never hits logs.
        console.error(
            "[generate-title] LLM call failed, using message-prefix fallback",
            safeErrorLog(err),
        );
    }

    // Upstream divergence (sync-log: ba6f771). The upstream version of this
    // endpoint updates by chat id alone:
    //     await db.from("chats").update({ title }).eq("id", chatId);
    //     res.json({ title });
    // Dev intentionally filters by `user_id` too, so a user can only rename
    // their own chats. Do not "simplify back" to upstream's form without
    // establishing an equivalent access guard upstream of this point.
    const { error: updateError } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId);
    if (updateError) {
        console.error("[generate-title] failed to persist title", {
            chatId,
            userId,
            error: updateError.message,
        });
        return void res.status(500).json({ detail: "Failed to save title" });
    }

    res.json({ title });
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedProjectId = parseOptionalProjectId(body.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }
    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const project_id = parsedProjectId.value.projectId;
    const model = parsedModel.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    // Reserve a stable assistant identity before streaming. This lets clients
    // associate streamed UI with the same durable message after a reload.
    const assistantMessageId = askInputsResponse ? null : randomUUID();

    console.log("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Either chat owner OR a member of the chat's project can post.
        const { data: existing } = await db
            .from("chats")
            .select("id, title, user_id, project_id")
            .eq("id", chatId)
            .single();
        let canUse = !!existing && existing.user_id === userId;
        if (!canUse && existing?.project_id) {
            const access = await checkProjectAccess(
                existing.project_id,
                userId,
                userEmail,
                db,
            );
            canUse = access.ok;
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: project_id ?? null })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    if (!chatId) {
        return void res
            .status(500)
            .json({ detail: "Failed to initialize chat" });
    }

    console.log("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (askInputsResponse) {
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            askInputsResponse,
        );
    } else if (lastUser) {
        const { error: userMessageError } = await db
            .from("chat_messages")
            .insert({
                chat_id: chatId,
                role: "user",
                content: lastUser.content,
                files: lastUser.files ?? null,
                workflow: lastUser.workflow ?? null,
            });
        if (userMessageError) {
            return void res.status(500).json({
                detail: "Failed to persist user message",
            });
        }
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    // Generate the nonce before enriching prior events so document filenames
    // and workflow titles replayed from earlier turns are fenced as well.
    const nonce = generateSpotlightNonce();
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const {
        api_keys: apiKeys,
        fast_model: fastModel,
        legal_research_us: legalResearchUs,
    } = await getUserModelSettings(userId, db);
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        undefined,
        undefined,
        legalResearchUs,
        nonce,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    console.log("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    // Make the advertised identity durable before the response becomes an
    // SSE stream. If this reservation fails, return a normal HTTP error while
    // headers are still mutable; clients must never receive an ID that cannot
    // subsequently be loaded from chat history.
    if (assistantMessageId) {
        const reserveError = await reserveAssistantMessage({
            db,
            table: "chat_messages",
            id: assistantMessageId,
            chatId,
        });
        if (reserveError) {
            console.error(
                "[chat/stream] failed to reserve assistant message",
                reserveError,
            );
            return void res
                .status(500)
                .json({ detail: "Failed to start assistant response" });
        }
    }

    const stream = openAssistantSse(res);
    const write = stream.write;
    const updateReservedAssistantMessage =
        createReservedAssistantMessageUpdater({
            db,
            table: "chat_messages",
            id: assistantMessageId ?? "",
            chatId,
            enabled: !!assistantMessageId,
        });

    try {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                ...(assistantMessageId ? { assistantMessageId } : {}),
            })}\n\n`,
        );

        const shouldGenerateTitle =
            !chatTitle && !!lastUser?.content && !askInputsResponse;
        const titleMessage = lastUser
            ? [
                  lastUser.content,
                  lastUser.workflow
                      ? `Workflow: ${lastUser.workflow.title}`
                      : "",
                  lastUser.files?.length
                      ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                      : "",
              ]
                  .filter(Boolean)
                  .join("\n")
            : "";
        const titlePromise = shouldGenerateTitle
            ? generateAssistantChatTitle({
                  model: fastModel,
                  message: titleMessage,
                  apiKeys,
              })
                  .then(async (title) => {
                      const { error } = await db
                          .from("chats")
                          .update({ title })
                          .eq("id", chatId);
                      if (error) throw error;
                      chatTitle = title;
                      if (!stream.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[chat/stream] failed to generate chat title",
                          safeErrorLog(error),
                      );
                  })
            : Promise.resolve();

        const { fullText, events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model,
            fastModel,
            apiKeys,
            signal: stream.signal,
            projectId: project_id ?? null,
            nonce,
            // This route first makes the advertised assistant ID durable.
            // It emits [DONE] only after the reserved row has been populated.
            emitDone: false,
        });

        console.log("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        if (askInputsResponse) {
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
        } else {
            const saveError = await updateReservedAssistantMessage(
                persistedEvents.length ? persistedEvents : null,
                citations.length ? citations : null,
            );
            if (saveError) {
                console.error(
                    "[chat/stream] failed to save assistant response",
                    saveError,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        message:
                            "The response was generated but could not be saved.",
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
                return;
            }
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await db
                .from("chats")
                .update({ title })
                .eq("id", chatId);
            chatTitle = title;
            if (shouldGenerateTitle && !stream.signal.aborted) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
        void recordChatTurn(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId: project_id ?? null,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model,
            },
            persistedEvents,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            devLog("[chat/stream] client aborted stream", { chatId });
            void recordChatTurn(
                db,
                {
                    userId,
                    userEmail,
                    chatId,
                    projectId: project_id ?? null,
                    title: chatTitle,
                    model,
                    status: "cancelled",
                },
                null,
            );
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractCitations(fullText, docIndex),
                });
                const saveError = askInputsResponse
                    ? null
                    : await updateReservedAssistantMessage(
                          partial.events.length ? partial.events : null,
                          partial.citations.length ? partial.citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToLastAssistantMessage(
                        db,
                        chatId,
                        partial.events,
                        partial.citations,
                    );
                }
                if (saveError) {
                    console.error(
                        "[chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[chat/stream] error:", safeErrorLog(err));
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        try {
            const citations = extractCitations(errorFullText, docIndex);
            const saveError = askInputsResponse
                ? null
                : await updateReservedAssistantMessage(
                      errorEvents.length ? errorEvents : null,
                      citations.length ? citations : null,
                  );
            if (askInputsResponse) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error("[chat/stream] failed to save error", saveError);
        } catch (saveErr) {
            console.error("[chat/stream] failed to save error", saveErr);
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        stream.finish();
    }
});
