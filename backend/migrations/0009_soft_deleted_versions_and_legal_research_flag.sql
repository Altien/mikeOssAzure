-- Upstream sync 1fa0554 (PR #178): soft-deleted document versions +
-- legal-research feature flag. Adapted from upstream's
-- oss-migrations/20260610_soft_deleted_document_versions.sql plus the
-- schema.sql user_profiles delta (Supabase-only items skipped — see
-- UPSTREAM_SYNC_LOG.md).
--
-- Idempotent: safe to re-run.

-- Keep document version tombstones after deleting version file bytes.
-- Deleted versions remain visible in history but are ignored by active-file
-- lookups and cannot be opened/downloaded/replaced.

alter table public.document_versions
  alter column storage_path drop not null;

alter table public.document_versions
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

-- Features > Legal Research > Jurisdiction > US toggle. Defaults to enabled
-- so existing users keep CourtListener tools in chat.

alter table public.user_profiles
  add column if not exists legal_research_us boolean not null default true;
