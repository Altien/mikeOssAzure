-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_02_playbook_content_column.sql
-- Staging order 04; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Migration date: 2026-10-17
-- A playbook has no draft/published split: its stored rules are its content.
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbooks' and column_name = 'draft_json') then
    alter table public.playbooks rename column draft_json to content_json;
  end if;
end $$;

notify pgrst, 'reload schema';
