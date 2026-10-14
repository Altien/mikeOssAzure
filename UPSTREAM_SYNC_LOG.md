
- 4dbd3d52 (#362): runtime-gated lazy Supabase recovery/callback/signup and password settings; retained Entra/local login and external MFA. Auth-owned trigger/schema, Supabase compose/config, and preview-only deleted MFA route excluded from Azure.

- Source105: org departure retention →0126_org_departure_retention.sql. Canonical TEXT identities and profile UUID provenance retained; prepare_account_org_departures is atomic within existing request_account_erasure; provider/session/tombstone guards and storage outbox preserved. needs_review.

- Source106: departure listing →0127_org_departure_listing.sql; actor TEXT/profile metadata UUID, private grants. Preserved local cookie guest login while adopting session warning and invitation onboarding. Retired browser harness omitted. needs_review.

- Source123 06c05192: 20261014_01_organization_audit_lifecycle.sql →0131_organization_audit_lifecycle.sql. Nullable TEXT actors/profile-delete nulling, active-org memory/managed credential gating, soft delete/restore/purge with durable document and private-logo cleanup. needs_review.

- Source124 a0598375: private-content access →0132_org_private_content_access.sql; audit-derived discovery →0133_audit_private_content_access.sql. TEXT actor/owner RPCs with UUID membership/provenance; explicit org-scoped audited viewer grant, no Entra deployment-admin bypass. needs_review.

- Source125 7058f104 dated rename mapping only: 20261014_03_organization_audit_lifecycle.sql →0131;20261014_04_org_private_content_access.sql →0132;20261014_05_audit_private_content_access.sql →0133. Canonical order already follows photos0128–0130; no SQL replay or new migration.

- Source134 99d25630: audit_actor_picker →0134_audit_actor_picker.sql. TEXT audit actor/results, UUID profile lookup via::text, service-only scope. Actor filter accepts bounded TEXT actor identifiers; picker/API callbacks retain account/workspace/epoch fences. needs_review.
