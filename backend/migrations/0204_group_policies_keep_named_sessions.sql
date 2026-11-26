-- cp_set_group_policies no longer signs named members out.
-- Roles are resolved from the current policies on every request, so a policy
-- change needs no sign-out to take effect. A named member ('altien' or
-- 'microsoft') is admitted by their membership row, never by a group policy;
-- a policy can only elevate a named Microsoft Member to TenantAdmin
-- (src/lib/auth/roles.ts). Only directory-link members ('enterprise', written
-- by mirror_enterprise_member) are admitted by policy, so only their sessions
-- are still revoked. Otherwise identical to 0194; CREATE OR REPLACE keeps the
-- function's owner and grants.
create or replace function public.cp_set_group_policies(p_tenant_id text,p_policies jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_policies is null or jsonb_typeof(p_policies)<>'array' then
    raise exception using errcode='22023',message='Group policies must be an array';
  end if;
  if exists(select 1 from jsonb_array_elements(p_policies) x where jsonb_typeof(x)<>'object'
    or jsonb_typeof(x->'groupObjectId') is distinct from 'string'
    or (x->>'groupObjectId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or x->>'role' is null or x->>'role' not in ('TenantAdmin','Member')
    or exists(select 1 from jsonb_object_keys(x) k where k<>all(array['groupObjectId','role']))) then
    raise exception using errcode='22023',message='Invalid group policy';
  end if;
  perform 1 from public.tenants where tenant_id=p_tenant_id and status<>'offboarding' for update;
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  delete from public.tenant_group_policies where tenant_id=p_tenant_id;
  insert into public.tenant_group_policies(tenant_id,group_object_id,role)
    select p_tenant_id,lower(x->>'groupObjectId'),x->>'role' from jsonb_array_elements(p_policies) x;
  perform app.revoke_member_sessions(user_id) from public.tenant_memberships
    where tenant_id=p_tenant_id and identity_kind='enterprise';
end $$;
