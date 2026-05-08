# Issue 022 — Frontend deployment to Azure

## Goal

Get Mike's web UI in front of users on a public Azure URL, alongside the
already-deployed backend API. Today the deployment is API-only — there
is no Static Web App, App Service, or additional Container App hosting
the frontend. Users cannot reach the app via a browser.

## Audit: what does Mike's frontend actually use from Next.js?

A focused read of `frontend/` revealed that the app barely uses any
Next.js server features. It is effectively a SPA with the App Router as
a routing convenience.

### Used (works with static export)

| Feature | Notes |
|---|---|
| `next/font/google` (Inter, EB_Garamond) | Build-time font fetching — fine for `output: 'export'`. |
| `Metadata` API in root layout | Static metadata, no dynamic data fetch. |
| App Router | Used purely for routing. All page contents are `"use client"`. |
| Client components | 85 files start with `"use client"`. |

### Used (requires conversion)

| Feature | Resolution |
|---|---|
| `redirect("/assistant")` in `app/page.tsx` (server-side) | Replace with `"use client"` + `useEffect` + `router.replace`. |
| `rewrites()` in `next.config.ts` pointing at `/api/sitemap/...` | Delete. The target paths don't exist — the rewrite was dead config left over from an earlier shape. |

### Not used at all

- Middleware (`middleware.ts`) — does not exist.
- API Routes (`route.ts`) — none anywhere under `src/app/api/`.
- Server Actions (`"use server"`) — zero matches across `src/`.
- `next/image` — zero imports.
- Server Components doing data fetches.
- ISR / SSG with dynamic data.
- Streaming, Edge runtime.

### Already configured but unused

- `open-next.config.ts` — wired for Cloudflare Workers via OpenNext.
  Suggests prior Cloudflare deployment intent. Kept as a fallback option
  but not part of the chosen path.

## Decision: ship as a static export

Given the audit, `output: 'export'` is the honest representation of how
this app actually works. The build produces pure HTML/JS/CSS in
`frontend/out/` that any static host can serve.

This unlocks every cheap and standard hosting option, and removes the
need for a Node runtime in the frontend deploy at all.

## Conversion required (small)

1. **`frontend/next.config.ts`**
   - Add `output: 'export'`.
   - Delete the `rewrites()` block (points at non-existent
     `/api/sitemap/...` paths).
   - Keep `reactCompiler: true` and `skipTrailingSlashRedirect: true`.

2. **`frontend/src/app/page.tsx`**
   - Convert from server-side `redirect("/assistant")` to a
     `"use client"` component using `useEffect` + `router.replace`.

These are the only changes needed. The 85 already-`"use client"`
components and the App Router structure require no edits.

## Hosting options

The static build can be served from any of:

| Option | Pros | Cons |
|---|---|---|
| **Bundle into the backend Container App** | Same FQDN as the API. One deploy unit. No new Azure resources. Cheapest. Mirrors the MatterAI shape (single zip, single host). | Frontend deploys are coupled to backend deploys. Requires Express `static` middleware + SPA fallback. |
| **Separate frontend Container App** | Consistent with the existing `backend` / `postgrest` pattern in Bicep. Independent deploy lifecycle. Runs e.g. nginx on the static `out/`. | Adds a Container App resource. CORS to wire up between the two FQDNs. |
| **Azure Static Web Apps (free SKU)** | Global CDN, free SSL, auto-CI from GitHub. Standard Marketplace answer. | Adds a new platform service to operate (separate from Container Apps). Requires its own GitHub Actions integration. |
| **Storage Static Website** | Pennies. | No CDN by default, no custom domain SSL without extra wiring. |
| **Cloudflare Workers via OpenNext** | Already configured (`open-next.config.ts`). Global edge. | Not Azure — fails the Marketplace "all-Azure" story. |

The choice depends on whether we want a single Container App
deployment now (simpler, mirrors MatterAI) or to keep frontend / backend
deploy lifecycles separate (more standard for SaaS).

**Open question.** The conversion to static export is independent of
this decision and lands first.

## Implementation steps

### Phase 1 — frontend conversion (this issue)

- [x] Audit Next.js feature usage (above)
- [ ] `next.config.ts` — add `output: 'export'`, remove dead rewrites
- [ ] `app/page.tsx` — client-side redirect
- [ ] Verify `npm run build` produces a complete `frontend/out/`
- [ ] Commit

### Phase 2 — pick a hosting target

- [ ] Decide between bundle-into-backend, separate Container App, or
      Static Web Apps based on operational preference
- [ ] Document the chosen hosting in this issue
- [ ] Implement (Dockerfile / Bicep / workflow changes)

### Phase 3 — deployment integration

- [ ] Update `deploy.ps1` and `.github/workflows/deploy.yml` to handle
      the frontend build / deploy step alongside the backend
- [ ] Update `check-azure.ps1` so the resource-inventory check no longer
      flags the missing frontend
- [ ] Update `docs/azure-production-hardening.md` — strike the
      "no frontend" line

## Followups (out of scope here)

- Marketplace listing in `016-marketplace-listing.md` will reference
  whichever hosting choice we land on.
- Custom domain + SSL once we have a stable URL.
