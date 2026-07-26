-- OSS-7 Skills: project-document scoping for a skill run (story 30) and the
-- explicit, visible chat upgrade path (runtime decision: "Root and dependency
-- versions are pinned for the chat lifetime. Upgrading an existing chat is
-- explicit and visible.").
--
-- `selected_document_ids` is empty for every existing binding, which is the
-- documented "no selection = whole-project read" behaviour, so this migration
-- changes no running chat.

alter table public.altien_chat_skill_bindings
  add column if not exists selected_document_ids jsonb not null default '[]'::jsonb,
  add column if not exists upgraded_from_version_id uuid
    references public.altien_skill_versions(id) on delete set null,
  add column if not exists upgraded_by text,
  add column if not exists upgraded_at timestamptz;
