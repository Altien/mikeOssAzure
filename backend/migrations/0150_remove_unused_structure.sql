-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_06_remove_unused_playbook_structure.sql
-- Staging order 09; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Migration date: 2026-10-17
-- Word structure is used only while compiling an import. Rules retain their
-- source references and the original file is stored separately; no reader
-- uses this duplicate parsed copy.
alter table public.playbooks drop column if exists source_structure_json;

notify pgrst, 'reload schema';
