# Altien-curated catalogs

Every stamp runs the existing workflow synchronization job with the platform
client (`pnpm --dir backend sync:workflows`). The global `mike_workflows`,
`mike_workflow_assets` and `workflow_addons*` tables are readable by
`tenant_app`; only the platform role can write them. Default installation
copies workflow content into ordinary tenant-owned rows. Installation markers
are unique by tenant, user and default key, so moving to another organisation
does not prevent a person installing the same defaults there. Editing a copy
never edits the global source. Preset templates remain a static frontend bundle.

Skills use the same copy rule. Set deployment config `altien-skill-catalog`
(or environment override `ALTIEN_SKILL_CATALOG`) to a JSON array:

```json
[
  {
    "id": "contract-review",
    "displayName": "Contract review",
    "description": "Review a contract against its requirements.",
    "url": "https://github.com/example/skills/tree/0000000000000000000000000000000000000000/contract-review"
  }
]
```

The URL is a placeholder: replace its repository and commit with the curated
source when deploying. A full 40-character commit SHA is required; mutable
branches/tags, duplicate IDs and non-GitHub hosts are rejected. Publish the
same manifest in each stamp. Missing config yields an empty catalog and no
additional controls. A configured vault outage fails closed.

An optional platform read-only GitHub credential uses Key Vault secret
`altien-skill-catalog-github-token`, with
`ALTIEN_SKILL_CATALOG_GITHUB_TOKEN` as the environment fallback. Tenant
credentials and tenant config cannot override this source or publish entries.
No credential is returned by the catalog endpoint.

Authenticated members can list `GET /api/altien/skills/catalog`. Tenant
admins choose an ID in Skills → Altien catalog, which sends
`POST /api/altien/skills/imports/catalog` with `{ "catalogId": "contract-review" }`.
The backend selects the trusted source, verifies repository/path/commit, and
runs the existing archive validation, tenant storage and DMS snapshot pipeline.
The result is an ordinary tenant-owned draft: review and enable still apply.
Catalog ID, display name and commit are retained in the snapshot's
`manifest.catalog`; GitHub provenance stays compatible with existing imports.
Changing a catalog pin never changes an existing tenant copy.

Curated sources are explicitly deployment-approved, so they are available
independently of the tenant's arbitrary-GitHub-import opt-in. Existing gates
for importing an arbitrary GitHub URL remain in force. No tenant publishing
route exists.
