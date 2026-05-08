# Issue 030 — Runtime Config Endpoint (kill `NEXT_PUBLIC_ENTRA_*`)

> **Status: shipped.** Backend `GET /config` and `GET /auth/logout` exist.
> Frontend `ConfigContext` is the single source of truth for `authProvider`
> and entra IDs. `frontend/src/lib/auth-provider.ts` deleted. **Note:**
> implementation mounts at `/config` and `/auth/logout` (current routing
> convention); the original spec said `/api/config` and `/api/auth/logout`,
> which will become correct once issue 028 (the `/api/*` prefix move)
> lands.

## Goal

Make the frontend bundle portable across deployments by removing every
customer-specific `NEXT_PUBLIC_*` value from the build. The same image
runs against any tenant; the backend serves the runtime config from
Key Vault.

After this lands, the only `NEXT_PUBLIC_*` reads in the frontend that
remain are `NEXT_PUBLIC_API_BASE_URL` (build-time-needed because the
bundle has to know where the backend lives before any round-trip
happens) and the supabase placeholders (retired in issue 031).

## Context

`next.config.ts` sets `output: "export"`. That means every
`process.env.X` reference in client code is **substituted at build
time**, not read at request time — there is no Node runtime serving
the frontend. The `NEXT_PUBLIC_` prefix is the marker Next.js looks
for when doing the substitution.

Today this forces us to commit `frontend/.env.production` with
concrete tenant GUIDs (`NEXT_PUBLIC_ENTRA_TENANT_ID=…`,
`NEXT_PUBLIC_ENTRA_CLIENT_ID=…`, `NEXT_PUBLIC_REDIRECT_URI=…`) so the
Docker build picks them up. The image that comes out is bound to one
specific Azure tenant. Marketplace customers would each need their
own image rebuild.

Tracing the existing reads (see `docs/migration/05-config-extraction.md`
for the full audit):

- `NEXT_PUBLIC_AUTH_PROVIDER` — selects the login-UI branch
  (`supabase` / `local` / `entra`). Deployment-mode choice, not
  tenant-specific.
- `NEXT_PUBLIC_ENTRA_TENANT_ID` — read in `AuthContext.tsx` line 137
  to build the Microsoft logout URL.
- `NEXT_PUBLIC_ENTRA_CLIENT_ID` — read in `AuthContext.tsx` line 135
  as a presence check before redirecting to logout. The value itself
  is not used.
- `NEXT_PUBLIC_REDIRECT_URI` — read in `AuthContext.tsx` line 136 as
  the `post_logout_redirect_uri`.
- `NEXT_PUBLIC_ENTRA_BACKEND_SCOPE` — defined in `auth-provider.ts`
  but **never read**. Dead.

The sign-in flow already does the right thing: `login/page.tsx`
redirects to `${apiBase}/auth/select-provider` and the **backend**
constructs the Microsoft authorize URL using its server-side env
vars. Only logout and the provider-mode toggle still read
`NEXT_PUBLIC_*`.

## What to build

### Backend

#### `GET /api/config`

Unauthenticated, cacheable, returns the runtime config the browser
needs at startup. Reads from server env / Key Vault using the same
`getConfig` helper the rest of the backend uses.

```ts
// Response shape
type PublicConfig = {
    authProvider: "supabase" | "local" | "entra";
    // Non-secret Entra values needed for client-side display logic.
    // Empty in non-entra modes.
    entra: {
        tenantId: string;
        clientId: string;
    };
};
```

**Why these values are OK to expose unauthenticated:** they end up in
the browser bundle either way (the supabase OAuth flow puts the
tenant ID in URLs; the Entra app registration is a public client
identifier). The reason for committing them today is purely a build-
mechanics workaround, not a confidentiality one. Surfacing them
through `/api/config` instead of through bundle baking changes the
delivery mechanism, not the threat model.

Cache headers: `Cache-Control: public, max-age=60` is plenty —
config changes are rare, and we already have `/install`'s
`flushConfigCache` for explicit invalidation.

Mount this **before** `requireAuth` in `index.ts` — it is
deliberately public.

#### `GET /api/auth/logout`

Server-constructed Microsoft logout redirect. Replaces the
client-side logout-URL building. Returns `302` to the Microsoft
logout URL with a server-known `post_logout_redirect_uri`.

```ts
// Behaviour:
//   - In entra mode: 302 → https://login.microsoftonline.com/{tid}/oauth2/v2.0/logout?post_logout_redirect_uri={redirect}
//     where redirect is `${FRONTEND_URL}/login` (server config).
//   - In local/supabase mode: 302 → ${FRONTEND_URL}/login
authRouter.get("/logout", (req, res) => { … });
```

The server already has all of `ENTRA_TENANT_ID`, `ENTRA_REDIRECT_URI`,
and `FRONTEND_URL` in env / KV — no new config required.

### Frontend

#### `frontend/src/contexts/ConfigContext.tsx` (new)

```tsx
type Config = {
    authProvider: "supabase" | "local" | "entra";
    entra: { tenantId: string; clientId: string };
};

const ConfigContext = createContext<Config | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
    const [config, setConfig] = useState<Config | null>(null);
    useEffect(() => {
        const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
        fetch(`${apiBase}/api/config`)
            .then((r) => r.json())
            .then(setConfig)
            .catch(() => setConfig({ authProvider: "supabase", entra: { tenantId: "", clientId: "" } }));
    }, []);
    return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): Config | null {
    return useContext(ConfigContext);
}
```

Wrap the app shell (`app/layout.tsx`) with `ConfigProvider` outside
`AuthProvider`, so auth bootstrap can read from config.

#### `frontend/src/lib/auth-provider.ts`

Delete this file. The values it exports (`authProvider`,
`isEntraAuth`, `isLocalAuth`, `entraConfig`) are all replaced by
`useConfig()` reads. Call sites that consumed them will need updates:

- `frontend/src/contexts/AuthContext.tsx` — switch to `useConfig()`
  for the provider mode and entra values; replace the inline logout
  URL construction with `window.location.href = "${apiBase}/api/auth/logout"`.
- `frontend/src/lib/supabase.ts` — provider check now reads from
  config (or from a `useConfig()` consumer; module-level `isLocalAuth`
  is going away).
- `frontend/src/lib/auth-token.ts` — same.
- `frontend/src/app/login/page.tsx` — same.

Some of these are module-level imports that need to become
context-aware. Three patterns:

1. **Components and hooks** — switch to `useConfig()` directly.
2. **Module-level helpers** (`getBrowserAccessToken`, etc.) —
   accept the provider mode as a parameter, or read it from a
   one-time `localStorage` cache populated on first config fetch.
3. **`bounceIfUnauthorized`** — does not depend on provider mode,
   no change needed.

The cleanest pattern is (1) wherever it works and (2) for the few
helpers called outside React. **Avoid writing the config to
`localStorage`** unless we have to — it duplicates state and creates
a "stale config" failure mode.

#### Frontend env-var deletes

After the refactor, `frontend/.env.local.example` and
`frontend/.env.production` (the latter handled by issue 032) drop:

- `NEXT_PUBLIC_AUTH_PROVIDER`
- `NEXT_PUBLIC_ENTRA_TENANT_ID`
- `NEXT_PUBLIC_ENTRA_CLIENT_ID`
- `NEXT_PUBLIC_ENTRA_BACKEND_SCOPE`
- `NEXT_PUBLIC_REDIRECT_URI`

Keep:

- `NEXT_PUBLIC_API_BASE_URL` (build-time-needed; see issue 032 for
  the strategy around it).

### Local dev

`AUTH_PROVIDER=local` mode needs `/api/config` to return
`authProvider: "local"`. The backend already reads `AUTH_PROVIDER` —
the new endpoint just surfaces it. Verify with:

```sh
curl http://localhost:3001/api/config
# {"authProvider":"local","entra":{"tenantId":"","clientId":""}}
```

## Acceptance criteria

- [ ] `GET /api/config` exists, requires no auth, returns the
      provider mode and entra values from server env.
- [ ] `GET /api/auth/logout` redirects (302) to the correct Microsoft
      logout URL in entra mode and to `${FRONTEND_URL}/login` in
      other modes.
- [ ] `frontend/src/lib/auth-provider.ts` is deleted.
- [ ] No `process.env.NEXT_PUBLIC_ENTRA_*` references remain in the
      frontend source.
- [ ] No `process.env.NEXT_PUBLIC_AUTH_PROVIDER` reference remains.
- [ ] No `process.env.NEXT_PUBLIC_REDIRECT_URI` reference remains.
- [ ] The login page renders the correct UI branch based on
      `useConfig()` after the initial config fetch (with a brief
      loading state instead of flashing the wrong UI).
- [ ] Microsoft sign-in still works end-to-end against the dev Azure
      deployment.
- [ ] Microsoft sign-out still redirects through Microsoft's logout
      page and back to `/login`.
- [ ] Local-mode sign-in / sign-out still works.
- [ ] Backend and frontend build cleanly with `NEXT_PUBLIC_ENTRA_*`
      removed from `.env.production`.

## Out of scope

- `NEXT_PUBLIC_API_BASE_URL` — covered in issue 032.
- `NEXT_PUBLIC_SUPABASE_*` placeholders — issue 031.
- Switching off `output: "export"`. Static export remains the right
  call; this issue makes the static bundle portable, not removes it.
- Versioning the `/api/config` payload — single shape for now.
  Future readers should tolerate unknown fields.

## Related

- Issue 031 — supabase placeholder removal (independent; can land in
  either order).
- Issue 032 — retire `frontend/.env.production` (depends on this issue
  and 031).
- `docs/migration/05-config-extraction.md` — full audit of which
  identifiers leak into the bundle today.
- `docs/migration/README.md` — AGPL publication motivation: a portable
  bundle is what makes the published fork a runnable artefact instead
  of a per-customer template.
