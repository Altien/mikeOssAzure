import { describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { FIXTURE_KEYS, type TenantFixture } from "./fixtures";
import { listRoutes, routeKey, routeParams } from "./routeInventory";
import { EXEMPT_ROUTES, paramIsCovered, planCall } from "./routePlan";

// Multi-tenant issue 009: the stack-backed canary (crossTenant.canary.ts,
// `npm run test:canary`) calls every route; this unit check keeps its plan
// complete on every normal test run.

const routes = listRoutes(buildApp());

describe("cross-tenant canary route plan", () => {
  it("finds the routers buildApp mounts, including parameterised mounts", () => {
    const keys = routes.map(routeKey);
    expect(keys).toContain("GET /api/projects/:projectId");
    expect(keys).toContain("PUT /api/projects/:projectId/memory");
    expect(keys).toContain("GET /api/tabular-review/:reviewId/chats/:chatId/messages");
    expect(routes.length).toBeGreaterThan(200);
  });

  it("has a tenant-B fixture for every path param of every non-exempt route", () => {
    const missing = routes
      .filter((route) => !(routeKey(route) in EXEMPT_ROUTES))
      .flatMap((route) =>
        routeParams(route.path)
          .filter((param) => !paramIsCovered(route.path, param))
          .map((param) => `${routeKey(route)} :${param}`),
      );
    expect(missing, "add the param to paramFixture() in routePlan.ts and seed it in fixtures.ts").toEqual([]);
  });

  it("lists no exemption for a route that no longer exists", () => {
    const keys = new Set(routes.map(routeKey));
    expect(Object.keys(EXEMPT_ROUTES).filter((key) => !keys.has(key))).toEqual([]);
  });

  it("fills every id param with tenant B's row", () => {
    const b: TenantFixture = {
      tenantId: "b",
      userId: "00000000-0000-4000-8000-00000000000b",
      email: "u@test.local",
      granteeEmail: "g@test.local",
      marker: "canary-b",
      ids: Object.fromEntries(FIXTURE_KEYS.map((key) => [key, `id-${key}`])) as TenantFixture["ids"],
    };
    const call = planCall({ method: "GET", path: "/api/tabular-review/:reviewId/chats/:chatId/messages" }, b, () => "fresh");
    expect(call).toMatchObject({ url: "/api/tabular-review/id-review/chats/id-reviewChat/messages", targetsTenantB: true });
    const self = planCall({ method: "PUT", path: "/api/user/api-keys/:provider" }, b, () => "fresh");
    expect(self.targetsTenantB).toBe(false);
    expect(self.body).toMatchObject({ project_id: "id-project" });
    const fileRoute = routes.find(route => routeKey(route) === "GET /api/single-documents/:documentId/file")!;
    expect(fileRoute).toBeDefined();
    expect(EXEMPT_ROUTES).not.toHaveProperty(routeKey(fileRoute));
    expect(planCall(fileRoute, b, () => "fresh")).toMatchObject({ url: "/api/single-documents/id-document/file", targetsTenantB: true });
  });
});
