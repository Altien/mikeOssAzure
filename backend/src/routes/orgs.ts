// Express router for organizations + RBAC, mounted at /orgs.
//
// Thin handlers: they read res.locals (userId/userEmail set by requireAuth),
// delegate to lib/orgs.ts, and map the discriminated results onto HTTP status
// codes with {detail} bodies — mirroring routes/projects.ts.
//
// Note what is NOT here: there is no "add a member" endpoint. Membership is
// created by accepting an invitation (POST /orgs/:orgId/invitations here,
// POST /user/invitations/:id/accept in routes/user.ts), so an admin can never
// pull somebody into a workspace full of confidential material without them
// agreeing to it.

import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
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
    type OrgResult,
} from "../lib/orgs";

export const orgsRouter = Router();

// Map the service's discriminated failure kinds onto HTTP responses. Kept in
// one place so every handler reports errors consistently.
//
// The split that matters here is between failures the caller CAUSED and
// failures the caller merely OBSERVED. The first six kinds are the service
// deliberately saying no, and their text is written for the person reading
// it. `db_error` is not a verdict at all — it is whatever Postgres said —
// and it goes out through sendInternalError so the client gets the generic
// message and the details stay in the server log.
export function sendOrgFailure(
    res: Response,
    result: Extract<OrgResult<unknown>, { ok: false }>,
) {
    switch (result.kind) {
        case "validation":
            return void res.status(400).json({ detail: result.detail });
        case "forbidden":
            return void res.status(403).json({
                detail: "Only an organization admin can do that.",
            });
        case "not_found":
            return void res
                .status(404)
                .json({ detail: "Organization not found" });
        case "conflict":
            return void res.status(409).json({ detail: result.detail });
        case "last_admin":
            return void res.status(409).json({
                detail: "An organization must keep at least one admin.",
            });
        case "expired":
            // 410 Gone: the invitation existed and is no longer actionable,
            // which is a different story from "never heard of it" (404).
            return void res
                .status(410)
                .json({ detail: "That invitation has expired." });
        case "db_error":
            // `result.detail` is a raw Postgres message: it can name tables,
            // columns, constraints and index definitions, and quote the
            // offending row — which in the org tables means somebody's email
            // address. sendInternalError logs it (with the request id, so
            // support can correlate) and answers with the generic body.
            return void sendInternalError(res, new Error(result.detail));
    }
}

// GET /orgs — orgs the caller belongs to (with their role + member count).
orgsRouter.get("/", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMyOrgs(db, userId);
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.orgs);
});

// POST /orgs — create an org; the caller becomes its first admin.
orgsRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await createOrg(db, { userId, name: req.body?.name });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(201).json(result.org);
});

// GET /orgs/:orgId — org detail (any member).
orgsRouter.get("/:orgId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getOrg(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
});

// PATCH /orgs/:orgId — rename the org (admin only).
orgsRouter.patch("/:orgId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await updateOrg(db, {
        userId,
        orgId: req.params.orgId,
        name: req.body?.name,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
});

// DELETE /orgs/:orgId — delete an empty org (admin only). Organization-owned
// resources never become personal data as a side effect of deletion.
orgsRouter.delete("/:orgId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await deleteOrg(db, {
        userId,
        userEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(204).send();
});

// GET /orgs/:orgId/resources — every organization-scoped project and workflow.
// Chats and tabular reviews only inherit organization access from projects and
// are browsed inside those projects rather than as independent org resources.
orgsRouter.get("/:orgId/resources", requireAuth, async (req, res) => {
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
});

// GET /orgs/:orgId/members — the accepted roster (any member).
orgsRouter.get("/:orgId/members", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMembers(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.members);
});

// PATCH /orgs/:orgId/members/:userId — change a member's role (admin only).
orgsRouter.patch("/:orgId/members/:userId", requireAuth, async (req, res) => {
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
});

// DELETE /orgs/:orgId/members/:userId — remove a member (admin, or self).
orgsRouter.delete("/:orgId/members/:userId", requireAuth, async (req, res) => {
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
});

// ---------------------------------------------------------------------------
// Invitations (admin side)
// ---------------------------------------------------------------------------

// POST /orgs/:orgId/invitations — invite an email at a role (admin only).
orgsRouter.post("/:orgId/invitations", requireAuth, async (req, res) => {
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
});

// GET /orgs/:orgId/invitations — pending/recent invitations (admin only).
orgsRouter.get("/:orgId/invitations", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listInvitations(db, {
        userId,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.invitations);
});

// DELETE /orgs/:orgId/invitations/:invitationId — cancel (admin only).
orgsRouter.delete(
    "/:orgId/invitations/:invitationId",
    requireAuth,
    async (req, res) => {
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
    },
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
    async (req, res) => {
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
    },
);
