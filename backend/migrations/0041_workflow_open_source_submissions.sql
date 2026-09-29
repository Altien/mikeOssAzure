-- 0041_workflow_open_source_submissions.sql
--
-- Review queue for user-submitted workflows that may later be published to
-- the open-source workflow repository. Written by `POST
-- /workflows/:id/open-source` (gated by WORKFLOW_CONTRIBUTIONS_ENABLED, off by
-- default); read/deleted by the user-data export/cleanup helpers.
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260629_01_workflow_open_source_submissions.sql`
-- (OSS-6 step A, upstream @ 204d2d53). Idempotent.
--
-- `submitted_by_user_id` stays `text` with no FK: dev has no `auth.users`.

create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  submitted_by_user_id text not null,
  submitter_email text,
  submitter_name text,
  contributor_mode text not null default 'anonymous',
  status text not null default 'pending',
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint workflow_open_source_submissions_contributor_mode_check
    check (contributor_mode in ('named', 'anonymous'))
);

create unique index if not exists idx_workflow_open_source_submissions_pending
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending';

create index if not exists idx_workflow_open_source_submissions_reviewer_queue
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists idx_workflow_open_source_submissions_submitter
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

-- Upstream's `enable row level security` / `revoke all privileges ... from
-- anon, authenticated` omitted: dev has no anon/authenticated PostgREST roles
-- and enforces access in the route (owner-only `.eq("user_id", userId)`) and
-- lib/access.ts (KNOWLEDGE §2.1). Upstream divergence (sync-log: OSS-6).
