import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueChatTurnAudit } from "../lib/audit";
import {
    buildProjectDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    buildWorkflowStore,
    enrichWithPriorEvents,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    spotlightFilename,
    stripTransientAssistantEvents,
    PROJECT_EXTRA_TOOLS,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalReasoning,
    type ChatMessage,
} from "../lib/chat";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { safeErrorLog } from "../lib/safeError";
import { generateAssistantChatTitle } from "../lib/chatTitle";
import { AUTHORITY_TRACE_SYSTEM_PROMPT } from "../altien/authorityTrace/chatTools";
import {
    getSkillChatBindingMetadata,
    loadSkillChatRuntimeContext,
} from "../altien/skills/runtime";
import { SKILL_RESOURCE_TOOLS } from "../altien/skills/resources";
import {
    bindExplicitSkillInvocation,
    mentionedEnabledSkillName,
    parseExplicitSkillInvocation,
    parseSkillInvocationCandidates,
    upgradeChatSkillBinding,
} from "../altien/skills/invocation";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../lib/modelSelection";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
Copies created with replicate_document are saved as project documents in this project. After replication, use the returned doc_id for any requested edits.

${AUTHORITY_TRACE_SYSTEM_PROMPT}`;

export const projectChatRouter = Router({ mergeParams: true });

/**
 * GET /projects/:projectId/chat/:chatId/skill — the skill this chat is bound
 * to, the documents its run was scoped to, and whether a newer enabled version
 * exists. Reporting an available upgrade never applies it; see the sibling
 * POST route.
 */
projectChatRouter.get("/:chatId/skill", requireAuth, async (req, res) => {
    const { projectId, chatId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(
        projectId,
        res.locals.userId as string,
        res.locals.userEmail as string | undefined,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Project not found" });
    const { data: chat } = await db
        .from("chats")
        .select("id, project_id")
        .eq("id", chatId)
        .single();
    if (!chat || chat.project_id !== projectId)
        return void res.status(404).json({ detail: "Chat not found" });
    try {
        res.json({ binding: await getSkillChatBindingMetadata({ chatId, db }) });
    } catch (error) {
        res.status(409).json({
            detail: "Skill binding is unavailable",
        });
    }
});

/**
 * POST /projects/:projectId/chat/:chatId/skill/upgrade — the only way a bound
 * chat ever changes version. The member must name the exact version they were
 * offered; the bind-time checks run again before the rebind is written.
 */
projectChatRouter.post(
    "/:chatId/skill/upgrade",
    requireAuth,
    async (req, res) => {
        const { projectId, chatId } = req.params;
        const toVersionId =
            typeof req.body?.toVersionId === "string"
                ? req.body.toVersionId.trim()
                : "";
        if (!toVersionId) {
            return void res
                .status(400)
                .json({ detail: "toVersionId is required." });
        }
        const tenantId = res.locals.principal?.tenantId;
        if (typeof tenantId !== "string" || !tenantId) {
            return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
        }
        const db = createServerSupabase();
        const access = await checkProjectAccess(
            projectId,
            res.locals.userId as string,
            res.locals.userEmail as string | undefined,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
        try {
            res.json(
                await upgradeChatSkillBinding({
                    tenantId,
                    projectId,
                    chatId,
                    userId: res.locals.userId as string,
                    toVersionId,
                    db,
                }),
            );
        } catch (error) {
            res.status(409).json({
                detail: "Skill upgrade failed",
            });
        }
    },
);

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
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
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedDisplayedDoc = parseOptionalDisplayedDoc(body.displayed_doc);
    if (!parsedDisplayedDoc.ok) {
        return void res.status(400).json({ detail: parsedDisplayedDoc.detail });
    }
    const parsedAttachedDocuments = parseOptionalAttachedDocuments(
        body.attached_documents,
    );
    if (!parsedAttachedDocuments.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAttachedDocuments.detail });
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
    const model = parsedModel.value;
    const displayed_doc = parsedDisplayedDoc.value;
    const attached_documents = parsedAttachedDocuments.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    /**
     * Story 30 (dev-only): project documents selected before an explicit
     * skill invocation starts. Only read when this turn binds a skill; not
     * part of upstream's validated request shape, so read off the raw body.
     */
    const skill_document_ids = body.skill_document_ids;

    const db = createServerSupabase();
    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, model, reasoning_level, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else {
            chatTitle = existing!.title;
            chatModel = (existing!.model as string | null) ?? null;
            chatReasoningLevel =
                (existing!.reasoning_level as string | null) ?? null;
        }
    }

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: model,
        chatModel,
        lastSelectedModel: modelSettings.last_selected_chat_model,
        apiKeys: modelSettings.api_keys,
        userId,
        db,
    });
    if (!modelResolution.ok) {
        return void res.status(modelResolution.status).json({
            code: modelResolution.code,
            detail: modelResolution.detail,
        });
    }
    const selectedModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedModel,
        requested: parsedReasoning.value,
        chatReasoningLevel,
        lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
    });

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) {
            return void res
                .status(500)
                .json({ detail: "Failed to save chat model" });
        }
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: projectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastUserText =
        typeof lastUser?.content === "string" ? lastUser.content : "";
    const principalTenantId =
        typeof res.locals.principal?.tenantId === "string"
            ? res.locals.principal.tenantId
            : undefined;
    let skillRuntime = await loadSkillChatRuntimeContext({
        chatId: chatId!,
        projectId,
        tenantId: principalTenantId,
        db,
    });
    // Only the unambiguous forms may reject a message outright; the looser
    // ones are resolved against the enabled skills before they mean anything.
    const explicitSkillName = lastUserText
        ? parseExplicitSkillInvocation(lastUserText)
        : null;
    const invocationCandidates = lastUserText
        ? parseSkillInvocationCandidates(lastUserText)
        : [];
    if (explicitSkillName && skillRuntime) {
        if (
            explicitSkillName.trim().toLocaleLowerCase() !==
            skillRuntime.displayName.trim().toLocaleLowerCase()
        ) {
            return void res.status(409).json({
                detail: `This chat is already bound to ${skillRuntime.displayName}. Start a new chat to use another skill.`,
            });
        }
    } else if (invocationCandidates.length && lastUser && !skillRuntime) {
        const tenantId = res.locals.principal?.tenantId;
        if (typeof tenantId !== "string" || !tenantId) {
            return void res.status(403).json({ detail: "TENANT_UNKNOWN" });
        }
        try {
            await bindExplicitSkillInvocation({
                tenantId,
                projectId,
                chatId: chatId!,
                userId,
                message: lastUserText,
                selectedDocumentIds: Array.isArray(skill_document_ids)
                    ? skill_document_ids
                    : [],
                db,
            });
            skillRuntime = await loadSkillChatRuntimeContext({
                chatId: chatId!,
                projectId,
                tenantId: principalTenantId,
                db,
            });
        } catch (error) {
            return void res.status(409).json({
                detail: "Explicit skill invocation failed",
            });
        }
    }
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

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
    );
    // Story 30: when the member scoped this skill run to particular project
    // documents, the unselected ones are removed from the context the tools
    // read from — not merely described as out of scope in the prompt.
    if (skillRuntime?.selectedDocumentIds.length) {
        const selected = new Set(skillRuntime.selectedDocumentIds);
        for (const [slug, info] of Object.entries(docIndex)) {
            if (selected.has(info.document_id)) continue;
            delete docIndex[slug];
            docStore.delete(slug);
            folderPaths.delete(slug);
        }
    }
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));
    const documentsById = new Map(
        Object.entries(docIndex).map(
            ([slug, document]) =>
                [
                    document.document_id,
                    { slug, filename: document.filename },
                ] as const,
        ),
    );
    // Generate the nonce before adding request metadata or prior events so
    // every document filename is fenced wherever it enters the prompt.
    const nonce = generateSpotlightNonce();
    const documentPromptRef = (documentId: string, requestFilename: string) => {
        const document = documentsById.get(documentId);
        return {
            slug: document?.slug,
            filename: spotlightFilename(
                document?.filename ?? requestFilename,
                nonce,
            ),
        };
    };

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              const displayedDocument = documentPromptRef(
                  displayed_doc.document_id,
                  displayed_doc.filename,
              );
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayedDocument.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (skillRuntime) {
        systemPromptExtra += `\n\n${skillRuntime.systemPrompt}`;
    } else if (lastUserText && principalTenantId) {
        // Naming a skill in passing must not load it — binding is explicit.
        // Saying nothing is worse though: the member believes the skill is
        // running while an ordinary chat answers them.
        const mentioned = await mentionedEnabledSkillName({
            tenantId: principalTenantId,
            message: lastUserText,
            db,
        });
        if (mentioned) {
            systemPromptExtra += `\n\nUNBOUND SKILL MENTION:
This chat is not bound to any skill, and you cannot load one yourself. The
member's message names the enabled skill "${mentioned}". If they meant to use
it, say so plainly and tell them to send "/skill ${mentioned}" — in this chat
if it has no skill yet, or in a new chat otherwise. Then answer as usual
without pretending to have the skill's instructions or resources.`;
        }
    }
    if (attached_documents?.length) {
        const lines = attached_documents.map((d) => {
            const document = documentPromptRef(d.document_id, d.filename);
            return document.slug
                ? `- ${document.slug}: ${document.filename}`
                : `- ${document.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const {
        api_keys: apiKeys,
        title_model: titleModel,
        legal_research_us: legalResearchUs,
        personalisation,
    } = modelSettings;
    const personalisationPrompt = buildUserPersonalisationPrompt(
        personalisation,
        nonce,
    );
    if (personalisationPrompt) {
        systemPromptExtra += `\n\n${personalisationPrompt}`;
    }
    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
        undefined,
        legalResearchUs,
        nonce,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

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
                  model: titleModelForChat(selectedModel, titleModel),
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
                      if (!streamAbort.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[project-chat/stream] failed to generate chat title",
                          safeErrorLog(error),
                      );
                  })
            : Promise.resolve();

        const { events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: skillRuntime
                ? [...PROJECT_EXTRA_TOOLS, ...SKILL_RESOURCE_TOOLS]
                : PROJECT_EXTRA_TOOLS,
            allowedToolNames: skillRuntime?.allowedToolNames,
            skillResourceStore: skillRuntime?.resourceStore,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            apiKeys,
            signal: streamAbort.signal,
            projectId,
            nonce,
            emitDone: false,
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
            await db.from("chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                citations: citations.length ? citations : null,
            });
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await db.from("chats").update({ title }).eq("id", chatId);
            chatTitle = title;
            if (shouldGenerateTitle && !streamAbort.signal.aborted) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }

        void enqueueChatTurnAudit(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model: selectedModel,
            },
            persistedEvents,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[project-chat/stream] client aborted stream", {
                chatId,
            });
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractCitations(fullText, docIndex),
                });
                const saveError = askInputsResponse
                    ? null
                    : (
                          await db.from("chat_messages").insert({
                              chat_id: chatId,
                              role: "assistant",
                              content: partial.events.length
                                  ? partial.events
                                  : null,
                              citations: partial.citations.length
                                  ? partial.citations
                                  : null,
                          })
                      ).error;
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
                        "[project-chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[project-chat/stream] error:", safeErrorLog(err));
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
                : (
                      await db.from("chat_messages").insert({
                          chat_id: chatId,
                          role: "assistant",
                          content: errorEvents.length ? errorEvents : null,
                          citations: citations.length ? citations : null,
                      })
                  ).error;
            if (askInputsResponse) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error(
                    "[project-chat/stream] failed to save error",
                    saveError,
                );
        } catch (saveErr) {
            console.error(
                "[project-chat/stream] failed to save error",
                saveErr,
            );
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});
