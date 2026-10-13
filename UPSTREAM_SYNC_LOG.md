
- 4dbd3d52 (#362): runtime-gated lazy Supabase recovery/callback/signup and password settings; retained Entra/local login and external MFA. Auth-owned trigger/schema, Supabase compose/config, and preview-only deleted MFA route excluded from Azure.

- Source105: org departure retention →0126_org_departure_retention.sql. Canonical TEXT identities and profile UUID provenance retained; prepare_account_org_departures is atomic within existing request_account_erasure; provider/session/tombstone guards and storage outbox preserved. needs_review.
