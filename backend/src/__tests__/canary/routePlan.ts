// Multi-tenant issue 009: how the cross-tenant canary calls each route.
//
// Every route buildApp() registers is called unless it is listed in
// EXEMPT_ROUTES with a reason. Path params are filled from tenant B's
// fixtures by name (paramFixture); a param with no mapping fails
// routePlan.test.ts, so a new route cannot slip past the canary without a
// fixture.

import type { FixtureKey, TenantFixture } from "./fixtures";
import { routeKey, routeParams, type RegisteredRoute } from "./routeInventory";

const AUTH_FLOW = "authentication flow: runs before a tenant is known, or on the caller's own session";
const OAUTH_CALLBACK = "unauthenticated OAuth callback: the tenant comes from the state row (008)";
const INSTALLER = "operator installer: bootstrap-token gated, off in pooled mode";
const PUBLIC = "public, serves no tenant data";
const PROVIDER_CATALOG = "provider model catalog: calls the provider, serves no tenant data";

export const EXEMPT_ROUTES: Record<string, string> = {
  "GET /config": PUBLIC,
  "GET /api/health": PUBLIC,
  "GET /api/manifest-signing-key": PUBLIC,
  "GET /api/help/articles": "static help content",
  "GET /api/help/articles/:slug": "static help content",
  "GET /api/download/:token": "signed download token; binding it to the tenant is issue 011",
  "GET /api/download/signed/:token": "filesystem presigned capability: HMAC over the tenant-prefixed key, read as that tenant (010)",
  "PUT /api/download/signed/:token": "filesystem presigned capability: HMAC over the tenant-prefixed key, written as that tenant (010)",
  "GET /api/models/configured": PROVIDER_CATALOG,
  "GET /api/models/opencode-go": PROVIDER_CATALOG,
  "GET /api/models/openrouter": PROVIDER_CATALOG,
  "GET /api/models/vercel": PROVIDER_CATALOG,
  "GET /api/llm/azure-openai/deployments": PROVIDER_CATALOG,
  "POST /api/altien/skills/imports/github": "fetches a repository from GitHub",
  "GET /api/altien/skills/settings/github/oauth/callback": OAUTH_CALLBACK,
  "GET /api/user/mcp-connectors/oauth/callback": OAUTH_CALLBACK,
  "GET /api/user/integrations/gmail/oauth/callback": OAUTH_CALLBACK,
  "GET /api/user/integrations/gmail/oauth/finish": OAUTH_CALLBACK,
  "GET /api/user/integrations/google-calendar/oauth/callback": OAUTH_CALLBACK,
  "GET /api/user/integrations/google-calendar/oauth/finish": OAUTH_CALLBACK,
  "GET /api/user/integrations/google-drive/oauth/callback": OAUTH_CALLBACK,
  "GET /api/user/integrations/google-drive/oauth/finish": OAUTH_CALLBACK,
  "GET /install": INSTALLER,
  "GET /install/auth/microsoft/callback": INSTALLER,
  "GET /install/auth/microsoft/start": INSTALLER,
  "GET /install/custom-domain": INSTALLER,
  "GET /install/groups/:groupId/members": INSTALLER,
  "GET /install/groups/me-member-of": INSTALLER,
  "GET /install/groups/search": INSTALLER,
  "GET /install/items/:id": INSTALLER,
  "GET /install/scripts/:name": INSTALLER,
  "POST /install/auth": INSTALLER,
  "POST /install/first-visit": INSTALLER,
  "POST /install/groups/save": INSTALLER,
  "POST /install/items/:id": INSTALLER,
  "POST /install/sign-out": INSTALLER,
  "DELETE /api/auth/mfa/factors/:factorId": AUTH_FLOW,
  "GET /api/auth/config": AUTH_FLOW,
  "GET /api/auth/login-provider/:providerId": AUTH_FLOW,
  "GET /api/auth/mfa/assurance": AUTH_FLOW,
  "GET /api/auth/mfa/factors": AUTH_FLOW,
  "GET /api/auth/oauth-callback/:provider": AUTH_FLOW,
  "GET /api/auth/openid-callback/:providerId": AUTH_FLOW,
  "GET /api/auth/providers": AUTH_FLOW,
  "GET /api/auth/recovery-callback": AUTH_FLOW,
  "GET /api/auth/select-provider": AUTH_FLOW,
  "GET /api/auth/session": AUTH_FLOW,
  "PATCH /api/auth/email": AUTH_FLOW,
  "PATCH /api/auth/password": AUTH_FLOW,
  "POST /api/auth/bootstrap": AUTH_FLOW,
  "POST /api/auth/handoff": AUTH_FLOW,
  "POST /api/auth/local-login": AUTH_FLOW,
  "POST /api/auth/login": AUTH_FLOW,
  "POST /api/auth/logout": AUTH_FLOW,
  "POST /api/auth/mfa/challenge": AUTH_FLOW,
  "POST /api/auth/mfa/challenge-and-verify": AUTH_FLOW,
  "POST /api/auth/mfa/enroll": AUTH_FLOW,
  "POST /api/auth/mfa/verify": AUTH_FLOW,
  "POST /api/auth/oauth": AUTH_FLOW,
  "POST /api/auth/password-reset": AUTH_FLOW,
  "POST /api/auth/reauthenticate": AUTH_FLOW,
  "POST /api/auth/refresh": AUTH_FLOW,
  "POST /api/auth/signup": AUTH_FLOW,
};

/** Params that are not tenant ids: a fixed, valid value. */
const STATIC_PARAMS: Record<string, string> = {
  kind: "files",
  provider: "openai",
  toolName: "search",
  partIndex: "0",
  blockIndex: "0",
};

/** Params with no seeded row behind them: a fresh id that exists nowhere. */
const UNSEEDED_PARAMS = new Set(["turnId", "exportId", "artifactId", "addonId", "assetId:/api/workflow-addons"]);

/**
 * The tenant-B fixture a path param refers to. Returns undefined for an
 * unknown param, which routePlan.test.ts reports as a missing fixture.
 */
export function paramFixture(path: string, param: string): FixtureKey | undefined {
  const under = (prefix: string) => path.startsWith(prefix);
  switch (param) {
    case "projectId": return "project";
    case "documentId": return "document";
    case "versionId": return under("/api/altien/") ? "skillVersion" : "documentVersion";
    case "editId": return "documentEdit";
    case "chatId":
      if (under("/api/tabular-review/")) return "reviewChat";
      if (under("/api/word-chat/")) return "wordChat";
      return "chat";
    case "reviewId": return "review";
    case "workflowId": return "workflow";
    case "shareId": return under("/api/playbooks/") ? "playbookShare" : "workflowShare";
    case "playbookId": return "playbook";
    case "sourceId": return under("/api/playbooks/") ? "playbookSource" : undefined;
    case "importId": return under("/api/playbooks/") ? "playbookImport" : undefined;
    case "archiveId": return "orgArchive";
    case "itemId": return under("/api/orgs/") ? "project" : undefined;
    case "referenceId": return "workflowReference";
    case "assetId": return under("/api/workflows/") ? "workflowAsset" : undefined;
    case "quickActionId": return "quickAction";
    case "reportId": return "supportReport";
    case "folderId": return under("/api/library/") ? "libraryFolder" : "projectFolder";
    case "orgId": return "org";
    case "invitationId": return "orgInvitation";
    case "sessionId": return "uploadSession";
    case "fileId": return "uploadFile";
    case "connectorId": return "connector";
    case "toolId": return "connectorTool";
    case "skillId": return "skill";
    case "runId": return "citationRun";
    case "messageId": return "wordMessage";
    default: return undefined;
  }
}

/** A param the plan can fill: a fixture, a static value, an unseeded id, or the shared user/email. */
export function paramIsCovered(path: string, param: string): boolean {
  return (
    paramFixture(path, param) !== undefined ||
    param in STATIC_PARAMS ||
    param === "userId" ||
    param === "email" ||
    isUnseeded(path, param)
  );
}

function isUnseeded(path: string, param: string): boolean {
  if (UNSEEDED_PARAMS.has(param)) return true;
  return [...UNSEEDED_PARAMS].some((entry) => {
    const [name, prefix] = entry.split(":");
    return name === param && prefix !== undefined && path.startsWith(prefix);
  });
}

export interface PlannedCall {
  route: RegisteredRoute;
  url: string;
  /** True when the URL names at least one of tenant B's rows. */
  targetsTenantB: boolean;
  body?: Record<string, unknown>;
}

export function planCall(route: RegisteredRoute, b: TenantFixture, freshId: () => string): PlannedCall {
  let targetsTenantB = false;
  let url = route.path;
  for (const param of routeParams(route.path)) {
    let value: string;
    const fixture = paramFixture(route.path, param);
    if (fixture) {
      value = b.ids[fixture];
      targetsTenantB = true;
    } else if (param in STATIC_PARAMS) {
      value = STATIC_PARAMS[param];
    } else if (param === "userId") {
      value = b.userId;
    } else if (param === "email") {
      value = b.granteeEmail;
    } else if (isUnseeded(route.path, param)) {
      value = freshId();
    } else {
      throw new Error(`No canary fixture for :${param} in ${routeKey(route)}`);
    }
    url = url.replace(`:${param}`, encodeURIComponent(value));
  }
  const body = route.method === "GET" ? undefined : tenantBPayload(b);
  return { route, url, targetsTenantB, body };
}

/** A request body naming tenant B's rows under the field names routes read. */
export function tenantBPayload(b: TenantFixture): Record<string, unknown> {
  const ids = b.ids;
  return {
    project_id: ids.project,
    projectId: ids.project,
    document_id: ids.document,
    document_ids: [ids.document],
    documentIds: [ids.document],
    version_id: ids.documentVersion,
    folder_id: ids.projectFolder,
    parent_folder_id: ids.projectFolder,
    chat_id: ids.chat,
    chatId: ids.chat,
    review_id: ids.review,
    workflow_id: ids.workflow,
    workflowId: ids.workflow,
    org_id: ids.org,
    connector_id: ids.connector,
    session_id: ids.uploadSession,
    message_id: ids.wordMessage,
    word_document_id: ids.wordDocument,
    skill_id: ids.skill,
    version: ids.skillVersion,
    ids: [ids.document],
    email: b.granteeEmail,
    name: "canary",
    title: "canary",
    messages: [{ role: "user", content: "canary" }],
  };
}

/**
 * Self-scoped calls that remove the caller's own data run after the rest,
 * and account erasure runs last (it closes the caller's account).
 */
export function callOrder(route: RegisteredRoute): number {
  if (routeKey(route) === "DELETE /api/user/account") return 3;
  if (route.method === "DELETE" && routeParams(route.path).length === 0) return 2;
  return 1;
}
