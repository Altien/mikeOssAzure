-- OSS-7 Skills: explicit review provenance for clean-room developer briefs.

alter table public.altien_skill_developer_artifacts
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

