-- Migration date: 2026-08-26

-- The profile value records an explicit picker action, not a successfully
-- completed chat turn. Preserve data written under the earlier name while
-- converging fresh and upgraded databases on the new semantics.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_profiles'
      and column_name = 'last_used_chat_model'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_profiles'
      and column_name = 'last_selected_chat_model'
  ) then
    alter table public.user_profiles
      rename column last_used_chat_model to last_selected_chat_model;
  else
    alter table public.user_profiles
      add column if not exists last_selected_chat_model text;

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_profiles'
        and column_name = 'last_used_chat_model'
    ) then
      update public.user_profiles
      set last_selected_chat_model = coalesce(
        last_selected_chat_model,
        last_used_chat_model
      );

      alter table public.user_profiles
        drop column last_used_chat_model;
    end if;
  end if;
end
$$;
