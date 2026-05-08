# Issue 024 — PostgREST Caddy Sidecar for Local-Prod Parity

> **Status: superseded.** We went the opposite direction: the
> in-process fetch wrapper in `backend/src/lib/supabase.ts` now
> handles the `/rest/v1` strip in **both** local and entra modes,
> and the local-stack Caddy gateway has been removed
> (`docker-compose.dev.yml`, `scripts/local-stack/Caddyfile`).
> Local and Azure both hit PostgREST directly. Marking closed.

## Goal

Mirror the local-stack Caddy gateway in the Azure PostgREST Container App so the backend can talk to PostgREST through `/rest/v1/...` URLs without the in-process fetch wrapper.

## Context

`@supabase/supabase-js` v2 hardcodes `${SUPABASE_URL}/rest/v1` as its REST base. This matches hosted Supabase but does not match a vanilla PostgREST, which serves tables at root.

Locally, the `scripts/local-stack/Caddyfile` runs a Caddy gateway that strips `/rest/v1/` before forwarding to PostgREST, keeping supabase-js calls working unchanged. The Azure PostgREST Container App was deployed without that gateway, and `SUPABASE_URL` was set directly to `http://postgrest`. Result: every supabase-js call 404'd inside `/rest/v1/...`, surfacing as the empty `{}` error chased through the issue 023 debug.

The current workaround is `postgrestEntraFetch` in `backend/src/lib/supabase.ts`, an in-process fetch wrapper that strips `/rest/v1/` from the URL on the way out (and also strips Authorization/apikey headers, which PostgREST without a JWT secret does not accept).

That workaround is fine and ships today, but it diverges from the local stack and makes the routing behavior a hidden in-app concern. Once supabase-js is removed (issues 021 / future PostgREST client work), the wrapper becomes irrelevant — but until then, parity is worth having.

## What to build

### Caddy sidecar in the PostgREST Container App

- Add a Caddy container alongside the PostgREST container in the same Container App (multi-container CA).
- Copy the `handle_path /rest/v1/* { reverse_proxy postgrest:3000 }` block from `scripts/local-stack/Caddyfile`.
- Listen on `:8000` (or the existing exposed PostgREST port — confirm there is no conflict).
- Update Container App ingress to target Caddy's port instead of PostgREST's 3000.

### Bicep changes

- Update `infra/modules/containerapp-postgrest.bicep` to declare the second container and the volume/ConfigMap-equivalent that supplies the Caddyfile.
- Adjust `targetPort` on the ingress block.
- Verify `postgrestInternalUrl` consumed by `containerapp-backend.bicep` still resolves correctly (likely unchanged — same FQDN, new port).

### Backend changes

- Once Caddy is fronting PostgREST, `postgrestEntraFetch` no longer needs the `/rest/v1/` strip — it can revert to the simple `stripAuthHeaders` form (or be removed entirely if Authorization/apikey headers stop being a problem after Caddy is in place — confirm via the diagnostic page).
- Keep the diagnostic page Test I; it will become a "this returns 200" pass instead of the current 404.

## Acceptance criteria

- [ ] PostgREST Container App runs Caddy + PostgREST as two containers.
- [ ] `SUPABASE_URL` from the backend points to the Caddy ingress, NOT the PostgREST container directly.
- [ ] Diagnostic page Test I (raw `/rest/v1/user_profiles`) returns 200 OK, not 404.
- [ ] All existing supabase-js call sites in the backend continue to work without the URL-rewrite wrapper.
- [ ] Local stack and Azure stack now have the same routing topology in front of PostgREST.
- [ ] Bicep deploy is idempotent — re-running `deploy.ps1` does not break the multi-container setup.

## Out of scope

- Removing `@supabase/supabase-js`. (See issue 021 and any successor.)
- Adding storage or auth routes to the gateway — backend already serves auth, storage is via Blob.
- Putting Caddy in front of the *backend* Container App. Backend does not need this rewrite.

## Dependencies

- 023 (install configurator design) — Caddy adds one more thing the install flow may want to verify is healthy.

## Notes

- This is local-prod parity, not a fix. The wrapper in `backend/src/lib/supabase.ts` already addresses the underlying bug. Prioritize after higher-value work unless Caddy gives us something else (e.g., it's where future rate limiting or path-based auth would live).
