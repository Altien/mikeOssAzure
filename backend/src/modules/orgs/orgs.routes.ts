// Express router for organizations + RBAC, mounted at /orgs.
//
// Thin handlers: they read res.locals (userId/userEmail set by requireAuth),
// delegate to orgs.service.ts, and map the discriminated results onto HTTP
// status codes with {detail} bodies — mirroring modules/projects.
//
// Note what is NOT here: there is no "add a member" endpoint. Membership is
// created by accepting an invitation (POST /orgs/:orgId/invitations here,
// POST /user/invitations/:id/accept in modules/user/user.routes.ts), so an
// admin can never pull somebody into a workspace full of confidential
// material without them agreeing to it.

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendOrgFailure } from "../../lib/orgFailure";
import {
    listMyOrgs,
    createOrg,
    getOrg,
    updateOrg,
    deleteOrg,
    listOrgResources,
    listMembers,
    updateMember,
    removeMember,
    createInvitation,
    listInvitations,
    cancelInvitation,
    resendInvitation,
    getOrgApiKeySettings,
    saveOrgApiKey,
    setOrgApiKeyEnabled,
    setOrgPersonalApiKeysAllowed,
} from "./orgs.service";
import { normalizeApiKeyProvider } from "../user/user.service";

export const orgsRouter = Router();

// GET /orgs — orgs the caller belongs to (with their role + member count).
orgsRouter.get("/", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMyOrgs(db, userId);
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.orgs);
}));

// POST /orgs — create an org; the caller becomes its first admin.
orgsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await createOrg(db, { userId, name: req.body?.name });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(201).json(result.org);
}));

// GET /orgs/:orgId — org detail (any member).
orgsRouter.get("/:orgId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getOrg(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
}));

// PATCH /orgs/:orgId — rename the org (admin only).
orgsRouter.patch("/:orgId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await updateOrg(db, {
        userId,
        orgId: req.params.orgId,
        name: req.body?.name,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
}));

// DELETE /orgs/:orgId — delete an empty org (admin only). Organization-owned
// resources never become personal data as a side effect of deletion.
orgsRouter.delete("/:orgId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await deleteOrg(db, {
        userId,
        userEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(204).send();
}));

// GET /orgs/:orgId/resources — every organization-scoped project and workflow.
// Chats and tabular reviews only inherit organization access from projects and
// are browsed inside those projects rather than as independent org resources.
orgsRouter.get("/:orgId/resources", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listOrgResources(db, {
        userId,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json({
        projects: result.projects,
        workflows: result.workflows,
    });
}));

// GET /orgs/:orgId/members — the accepted roster (any member).
orgsRouter.get("/:orgId/members", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMembers(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.members);
}));

// PATCH /orgs/:orgId/members/:userId — change a member's role (admin only).
orgsRouter.patch("/:orgId/members/:userId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await updateMember(db, {
        actorId: userId,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
        targetUserId: req.params.userId,
        role: req.body?.role,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.member);
}));

// DELETE /orgs/:orgId/members/:userId — remove a member (admin, or self).
orgsRouter.delete("/:orgId/members/:userId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await removeMember(db, {
        actorId: userId,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
        targetUserId: req.params.userId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(204).send();
}));

// ---------------------------------------------------------------------------
// Invitations (admin side)
// ---------------------------------------------------------------------------

// POST /orgs/:orgId/invitations — invite an email at a role (admin only).
orgsRouter.post("/:orgId/invitations", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await createInvitation(db, {
        actorId: userId,
        actorEmail: userEmail,
        orgId: req.params.orgId,
        email: req.body?.email,
        role: req.body?.role,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(201).json(result.invitation);
}));

// GET /orgs/:orgId/invitations — pending/recent invitations (admin only).
orgsRouter.get("/:orgId/invitations", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listInvitations(db, {
        userId,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.invitations);
}));

// DELETE /orgs/:orgId/invitations/:invitationId — cancel (admin only).
orgsRouter.delete(
    "/:orgId/invitations/:invitationId",
    requireAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await cancelInvitation(db, {
            actorId: userId,
            actorEmail: userEmail,
            orgId: req.params.orgId,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.status(204).send();
    }),
);

// POST /orgs/:orgId/invitations/:invitationId/resend — refresh expiry.
//
// The repository has no outbound email infrastructure, so "resend" moves the
// expiry window rather than re-delivering a message; the invitation surfaces
// in-app through GET /user/invitations either way. Wiring a mailer in would
// mean adding a dependency this PR deliberately does not take on.
orgsRouter.post(
    "/:orgId/invitations/:invitationId/resend",
    requireAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await resendInvitation(db, {
            actorId: userId,
            actorEmail: userEmail,
            orgId: req.params.orgId,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.invitation);
    }),
);

// ---------------------------------------------------------------------------
// Provider keys and the personal-key setting
// ---------------------------------------------------------------------------
//
// Writes carry requireMfaIfEnrolled, as the personal key routes do: saving a
// key decides where the organization's work is sent.

// GET /orgs/:orgId/api-keys — which providers are set up (any member).
// Reports configuration only; a saved key is never sent back.
orgsRouter.get("/:orgId/api-keys", requireAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await getOrgApiKeySettings(db, {
        userId: res.locals.userId as string,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.settings);
}));

// PUT /orgs/:orgId/api-keys/policy — whether members' own keys may be used
// for a provider the organization has no key for (owner or admin).
// Declared before /:provider so "policy" is never read as a provider name.
orgsRouter.put(
    "/:orgId/api-keys/policy",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const result = await setOrgPersonalApiKeysAllowed(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            allowed: req.body?.allow_personal_api_keys,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

// PUT /orgs/:orgId/api-keys/:provider — save, replace or (with no key and
// no settings) remove the organization's key (owner or admin).
orgsRouter.put(
    "/:orgId/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res.status(400).json({ detail: "Unsupported provider" });
        const db = createServerSupabase();
        const result = await saveOrgApiKey(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            provider,
            apiKey:
                typeof req.body?.api_key === "string" ? req.body.api_key : null,
            settings:
                req.body && typeof req.body === "object"
                    ? (req.body as { settings?: unknown }).settings
                    : undefined,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

// PATCH /orgs/:orgId/api-keys/:provider — keep the key, turn the provider
// off or on for the organization (owner or admin).
orgsRouter.patch(
    "/:orgId/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider || typeof req.body?.enabled !== "boolean")
            return void res.status(400).json({
                detail: "A supported provider and boolean enabled value are required.",
            });
        const db = createServerSupabase();
        const result = await setOrgApiKeyEnabled(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            provider,
            enabled: req.body.enabled,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

orgsRouter.use(routerErrorHandler("[orgs]"));
