-- 0024_citation_verification_reviews.sql
--
-- Append-only human citation-verdict history.

create table if not exists public.citation_verification_reviews (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.citation_verification_runs(id) on delete cascade,
  citation_id text not null,
  binds_to text not null,
  verdict text not null check (verdict in (
    'verified',
    'needs_attention',
    'rejected'
  )),
  note text,
  reviewer_user_id text not null,
  reviewer_email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_citation_verification_reviews_current
  on public.citation_verification_reviews(run_id, citation_id, created_at desc, id desc);
