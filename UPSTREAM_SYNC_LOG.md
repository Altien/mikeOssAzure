
- 4dbd3d52 (#362): runtime-gated lazy Supabase recovery/callback/signup and password settings; retained Entra/local login and external MFA. Auth-owned trigger/schema, Supabase compose/config, and preview-only deleted MFA route excluded from Azure.

- Source105: org departure retention →0126_org_departure_retention.sql. Canonical TEXT identities and profile UUID provenance retained; prepare_account_org_departures is atomic within existing request_account_erasure; provider/session/tombstone guards and storage outbox preserved. needs_review.

- Source106: departure listing →0127_org_departure_listing.sql; actor TEXT/profile metadata UUID, private grants. Preserved local cookie guest login while adopting session warning and invitation onboarding. Retired browser harness omitted. needs_review.

- Source123 06c05192: 20261014_01_organization_audit_lifecycle.sql →0131_organization_audit_lifecycle.sql. Nullable TEXT actors/profile-delete nulling, active-org memory/managed credential gating, soft delete/restore/purge with durable document and private-logo cleanup. needs_review.

- Source124 a0598375: private-content access →0132_org_private_content_access.sql; audit-derived discovery →0133_audit_private_content_access.sql. TEXT actor/owner RPCs with UUID membership/provenance; explicit org-scoped audited viewer grant, no Entra deployment-admin bypass. needs_review.

- Source125 7058f104 dated rename mapping only: 20261014_03_organization_audit_lifecycle.sql →0131;20261014_04_org_private_content_access.sql →0132;20261014_05_audit_private_content_access.sql →0133. Canonical order already follows photos0128–0130; no SQL replay or new migration.

- Source134 99d25630: audit_actor_picker →0134_audit_actor_picker.sql. TEXT audit actor/results, UUID profile lookup via::text, service-only scope. Actor filter accepts bounded TEXT actor identifiers; picker/API callbacks retain account/workspace/epoch fences. needs_review.

- Source138 399ea5a7: lifecycle review fixes →0135_org_lifecycle_review_fixes.sql; selected-row audit pagination →0136_paginate_organization_audit.sql. Preserve TEXT actors/filters, validated UUID profile provenance, private grants. Inactive-org departures archive instead of transferring; shared canonical erasure retains profile cascade behavior. needs_review.

- Source153 58b2687b: document text search →0137; updated sort →0138; History status →0139; creator filter →0140; generation activity →0141. Canonical TEXT/UUID access and private service-role history; preserve0061 stale-cell reset. Parent placement/read original-workspace corrections follow as separate fix. needs_review.

  Dev queue translation:0137 processing/publication/terminal failure RPCs retain canonical job→version→text lock order, claim token/attempt/payload/revision checks and retry/cancel guards. Disabled-runner inline work uses the same claim_db_job/processClaimedJob facade.

  Separate153 fix: server-resolved search_source.workspace stays request-scoped and is rechecked before read/revision. No cross-turn persistence added. Find parent joins/CASE fail closed for dangling parents and preserve parentNULL Personal; original actor retained.

- Source178 e8f73821: delegation modules, per-user defaults and retained continuations →0158/0159;0160 extends canonical fenced assistant append atomically with initiating actor/chat/message/workspace/document/version checks. No raw continuation insert path; cancellation-aware edit locks, scoped approval inheritance and canonical account erasure retained. needs_review.

- Source179 d9c0f573: subagent pills/document content cards and opt-in response details →0161_user_response_details.sql. Retained managed credential UI, TEXT actor configuration and deploy-before-migrate profile fallbacks. needs_review.

- Source180 19fb8ea1: complete durable Playbooks lifecycle, canonical job/token/lease guarded domain and existing document revision publication; numbered0162–0167. NULL replacement target fails closed; replacement CAS, claim-specific staged-key cleanup, current scope/roles, atomic audit, account handover/export/erasure and Word Personal attachments retained. needs_review.
