-- Source180 Dev adaptation: one domain transaction, canonical db_jobs ownership.
create or replace function public.mutate_playbook_job(
  p_job_id uuid,p_attempt integer,p_token uuid,p_operation text,p_domain_id uuid,
  p_values jsonb default '{}'::jsonb,p_terminal boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  job public.db_jobs; attempt public.playbook_imports; review public.playbook_runs;
  book public.playbooks; document public.documents; actor text; email text;
  book_id uuid; snapshot_org uuid; current_org uuid; member_role text; override_role text; access_role text;
  expected_id uuid; expected_path text; outcomes jsonb; detail jsonb; action text; title text; outcome_status text;
begin
  -- The canonical queue always locks before its domain/document rows.
  select * into job from public.db_jobs where id=p_job_id for update;
  if not found or job.attempts is distinct from p_attempt or job.claim_token is distinct from p_token
    or (p_terminal and job.status<>'failed')
    or (not p_terminal and (job.status<>'running' or job.lease_expires_at is null or job.lease_expires_at<=clock_timestamp()))
    then return jsonb_build_object('result','stale'); end if;
  if p_terminal and p_operation not in ('failure','check') then return jsonb_build_object('result','stale'); end if;
  actor:=job.payload->>'userId'; email:=job.payload->>'userEmail';
  if job.kind='playbook.import' then
    if job.payload->>'attemptId' is distinct from p_domain_id::text then return jsonb_build_object('result','stale'); end if;
    select * into attempt from public.playbook_imports where id=p_domain_id and user_id=actor for update;
    if not found then return jsonb_build_object('result','stale'); end if;
    book_id:=(job.payload->>'replacePlaybookId')::uuid;
    snapshot_org:=(job.payload->>'orgId')::uuid;
  elsif job.kind='playbook.review' then
    if job.payload->>'runId' is distinct from p_domain_id::text then return jsonb_build_object('result','stale'); end if;
    select * into review from public.playbook_runs where id=p_domain_id and user_id=actor for update;
    if not found then return jsonb_build_object('result','stale'); end if;
    book_id:=review.playbook_id; snapshot_org:=(job.payload->>'orgId')::uuid;
  else return jsonb_build_object('result','stale'); end if;
  if p_operation='check' then return jsonb_build_object('result','current'); end if;
  if coalesce(attempt.status,review.status)<>'running' then return jsonb_build_object('result','settled'); end if;
  if p_operation in ('heartbeat','import_progress','failure') then
    if not p_terminal and job.lease_expires_at<=clock_timestamp() then return jsonb_build_object('result','stale'); end if;
    if job.kind='playbook.import' then
      update public.playbook_imports set
        stage=coalesce(p_values->>'stage',stage),
        status=case when p_operation='failure' or p_values->>'status'='failed' then 'failed' else status end,
        error=case when p_operation='failure' or p_values->>'status'='failed' then coalesce(p_values->>'error','The import stopped. Import it again.') else error end,
        completed_at=case when p_operation='failure' or p_values->>'status'='failed' then clock_timestamp() else completed_at end,
        updated_at=clock_timestamp() where id=attempt.id;
      outcome_status:=case when p_operation='failure' or p_values->>'status'='failed' then 'failed' end;
      action:=case when book_id is null then 'playbook.imported' else 'playbook.replaced' end;
      title:=coalesce(attempt.requested_name,attempt.filename);
      detail:=jsonb_build_object('import_id',attempt.id,'playbook_id',book_id,'stage',coalesce(p_values->>'stage',attempt.stage));
    else
      update public.playbook_runs set
        status=case when p_operation='failure' then 'failed' else status end,
        error=case when p_operation='failure' then coalesce(p_values->>'error','The review stopped. Run it again.') else error end,
        completed_at=case when p_operation='failure' then clock_timestamp() else completed_at end,
        updated_at=clock_timestamp() where id=review.id;
      outcome_status:=case when p_operation='failure' then 'failed' end;
      action:='playbook.run'; title:=review.content_json->>'name';
      detail:=jsonb_build_object('playbook_id',book_id,'run_id',review.id,'scope',review.review_scope,'posture',review.review_mode);
    end if;
    if outcome_status is not null then
      insert into public.audit_events(user_id,user_email,org_id,action,status,title,surface,model,document_id,detail)
        values(actor,email,snapshot_org,action,outcome_status,title,'playbooks',coalesce(attempt.model,review.model),review.document_id,detail);
    end if;
    return jsonb_build_object('result','updated');
  end if;
  -- Freeze the existing role inputs while validating publication. These are the
  -- exact Playbooks membership/creator/public/override/share roles; no admin bypass.
  lock table public.organizations,public.org_members,public.playbook_org_access_overrides,
    public.playbook_shares,public.projects,public.workflows,public.documents,public.document_versions,
    public.project_access_grants,public.workflow_shares,public.project_org_access_overrides,
    public.workflow_org_access_overrides,public.org_private_content_access in share mode;
  if not public.org_is_active(snapshot_org) then return jsonb_build_object('result','forbidden'); end if;
  if snapshot_org is not null and not exists(select 1 from public.active_org_members m where m.org_id=snapshot_org and m.user_id::text=actor)
    then return jsonb_build_object('result','forbidden'); end if;
  if book_id is not null then
    select * into book from public.playbooks where id=book_id for update;
    if not found or book.org_id is distinct from snapshot_org or not public.org_is_active(book.org_id)
      then return jsonb_build_object('result','forbidden'); end if;
    if book.org_id is not null then
      select m.role into member_role from public.active_org_members m where m.org_id=book.org_id and m.user_id::text=actor;
      select o.role into override_role from public.playbook_org_access_overrides o where o.playbook_id=book.id and o.org_id=book.org_id and o.user_id::text=actor;
      access_role:=case when member_role is null then null when book.user_id=actor then 'owner'
        when member_role='owner' and book.visibility='organization' then 'owner'
        when override_role='deny' then null when override_role is not null then override_role
        when book.visibility='organization' then 'viewer' else null end;
    else
      access_role:=case when book.user_id=actor then 'owner' else
        (select s.role from public.playbook_shares s where s.playbook_id=book.id and lower(s.shared_with_email)=lower(email) limit 1) end;
    end if;
    if access_role is null or (job.kind='playbook.import' and access_role not in ('owner','editor'))
      then return jsonb_build_object('result','forbidden'); end if;
  end if;
  if job.lease_expires_at<=clock_timestamp() then return jsonb_build_object('result','stale'); end if;
  if p_operation='document_check' and job.kind='playbook.review' then
    select * into document from public.documents where id=review.document_id and archived_at is null for update;
    if not found or not public.document_text_access(document.id,actor,email) then return jsonb_build_object('result','forbidden'); end if;
    current_org:=case when document.project_id is not null then (select org_id from public.projects where id=document.project_id)
      when document.workflow_id is not null then (select org_id from public.workflows where id=document.workflow_id) else document.org_id end;
    current_org:=case when public.org_is_team(current_org) then current_org else null end;
    if current_org is distinct from snapshot_org then return jsonb_build_object('result','forbidden'); end if;
    expected_id:=(job.payload->'expectedVersion'->>'id')::uuid;
    expected_path:=job.payload->'expectedVersion'->>'storagePath';
    if expected_id is null or expected_path is null or document.current_version_id is distinct from expected_id
      or not exists(select 1 from public.document_versions v where v.id=expected_id and v.document_id=document.id
        and v.storage_path=expected_path and v.deleted_at is null) then return jsonb_build_object('result','conflict'); end if;
    if not (case when document.project_id is not null then
        (select public.project_access_role(p.id,p.user_id,p.org_id,actor,email) in ('owner','editor') from public.projects p where p.id=document.project_id)
      when document.workflow_id is not null then
        (select public.workflow_access_role(w.id,w.user_id,w.org_id,actor,email) in ('owner','editor') from public.workflows w where w.id=document.workflow_id)
      else document.user_id=actor and public.org_is_active(document.org_id) and
        (not public.org_is_team(document.org_id) or exists(select 1 from public.active_org_members m where m.org_id=document.org_id and m.user_id::text=actor)) end)
      then return jsonb_build_object('result','forbidden'); end if;
    return jsonb_build_object('result','current');
  end if;
  if p_operation='import_publish' and job.kind='playbook.import' then
    if job.payload->>'documentId' is not null then
      select * into document from public.documents where id=(job.payload->>'documentId')::uuid and archived_at is null;
      if not found or not public.document_text_access(document.id,actor,email) then return jsonb_build_object('result','forbidden'); end if;
      current_org:=case when document.project_id is not null then (select org_id from public.projects where id=document.project_id)
        when document.workflow_id is not null then (select org_id from public.workflows where id=document.workflow_id) else document.org_id end;
      current_org:=case when public.org_is_team(current_org) then current_org else null end;
      if current_org is distinct from snapshot_org or not exists(select 1 from public.document_versions v
        where v.id=document.current_version_id and v.document_id=document.id and v.deleted_at is null
          and v.storage_path=job.payload->>'sourceStoragePath') then return jsonb_build_object('result','conflict'); end if;
    end if;
    if book_id is not null then
      -- NULL never authorizes an overwrite. Both the stored snapshot and job
      -- snapshot must agree; the locked row CAS is the actual write fence.
      if attempt.target_updated_at is null or job.payload->>'targetUpdatedAt' is null
        or attempt.target_updated_at is distinct from (job.payload->>'targetUpdatedAt')::timestamptz
        or book.updated_at is distinct from attempt.target_updated_at
        or p_values->>'id' is distinct from book.id::text then return jsonb_build_object('result','conflict'); end if;
      update public.playbooks set name=p_values->>'name',description=coalesce(p_values->>'description',''),
        content_json=p_values->'content_json',source_filename=p_values->>'source_filename',
        source_storage_key=p_values->>'source_storage_key',import_model=attempt.model,updated_at=clock_timestamp()
        where id=book.id and updated_at=attempt.target_updated_at;
      if not found then return jsonb_build_object('result','conflict'); end if;
    else
      book_id:=(job.payload->>'newPlaybookId')::uuid;
      if book_id is null or p_values->>'id' is distinct from book_id::text then return jsonb_build_object('result','stale'); end if;
      insert into public.playbooks(id,user_id,org_id,name,description,content_json,source_filename,source_storage_key,import_model)
        values(book_id,actor,snapshot_org,p_values->>'name',coalesce(p_values->>'description',''),p_values->'content_json',
          p_values->>'source_filename',p_values->>'source_storage_key',attempt.model);
    end if;
    update public.playbook_imports set status='completed',stage='completed',playbook_id=book_id,
      error=null,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=attempt.id;
    insert into public.audit_events(user_id,user_email,org_id,action,status,title,surface,model,detail)
      values(actor,email,snapshot_org,case when job.payload->>'replacePlaybookId' is null then 'playbook.imported' else 'playbook.replaced' end,
        'completed',p_values->>'name','playbooks',attempt.model,jsonb_build_object('import_id',attempt.id,'playbook_id',book_id));
    return jsonb_build_object('result','published','id',book_id);
  elsif p_operation='review_publish' and job.kind='playbook.review' then
    if review.document_id is not null then
      select * into document from public.documents where id=review.document_id and archived_at is null;
      if not found or not public.document_text_access(document.id,actor,email) then return jsonb_build_object('result','forbidden'); end if;
      current_org:=case when document.project_id is not null then (select org_id from public.projects where id=document.project_id)
        when document.workflow_id is not null then (select org_id from public.workflows where id=document.workflow_id) else document.org_id end;
      current_org:=case when public.org_is_team(current_org) then current_org else null end;
      if current_org is distinct from snapshot_org then return jsonb_build_object('result','forbidden'); end if;
      expected_id:=coalesce((p_values->>'edited_version_id')::uuid,(job.payload->'expectedVersion'->>'id')::uuid);
      if expected_id is not null and (document.current_version_id is distinct from expected_id or not exists(
        select 1 from public.document_versions v where v.id=expected_id and v.document_id=document.id and v.deleted_at is null))
        then return jsonb_build_object('result','conflict'); end if;
    end if;
    update public.playbook_runs set status='completed',summary=p_values->>'summary',findings_json=p_values->'findings_json',
      edited_version_id=(p_values->>'edited_version_id')::uuid,error=null,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=review.id;
    select coalesce(jsonb_object_agg(status,count),'{}'::jsonb) into outcomes from (
      select value->>'status' status,count(*) count from jsonb_array_elements(p_values->'findings_json') group by value->>'status'
    ) counts;
    insert into public.audit_events(user_id,user_email,org_id,action,status,title,surface,model,document_id,detail)
      values(actor,email,snapshot_org,'playbook.run','completed',coalesce(review.content_json->>'name',book.name),'playbooks',review.model,review.document_id,
        jsonb_build_object('playbook_id',book.id,'run_id',review.id,'scope',review.review_scope,'posture',review.review_mode,'outcomes',outcomes));
    return jsonb_build_object('result','published');
  end if;
  return jsonb_build_object('result','stale');
end;
$$;
revoke all on function public.mutate_playbook_job(uuid,integer,uuid,text,uuid,jsonb,boolean) from public,web_anon,authenticated;
grant execute on function public.mutate_playbook_job(uuid,integer,uuid,text,uuid,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
