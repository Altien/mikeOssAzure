-- Run only on a disposable database after the numbered migrations, as its owner.
-- Dev: fixtures need a tenants row and a request.jwt.claims tenant (0180's
-- forced RLS applies inside the tenant_definer-owned function); actor ids are
-- text. Job mode (Dev's fenced worker path) is exercised after the inline mode.
-- All synthetic rows, helpers and test triggers are rolled back. No external
-- workers or storage are needed. Concurrent publishers/lost acknowledgements
-- require separate multi-session tests; this covers the persistence boundary.
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;

-- Include the candidate even when its version row has disappeared, so orphaned
-- trigger-created jobs cannot escape the rollback/no-debris assertions.
create function pg_temp.review_document_state(doc uuid, candidate uuid)
returns jsonb language sql as $$
  with versions as (
    select id from public.document_versions where document_id = doc
    union select candidate
  )
  select jsonb_build_object(
    'document', (select to_jsonb(d) from public.documents d where id = doc),
    'versions', (select jsonb_agg(to_jsonb(v) order by v.id)
      from public.document_versions v where document_id = doc or id = candidate),
    'edits', (select jsonb_agg(to_jsonb(e) order by e.id)
      from public.document_edits e where document_id = doc or version_id = candidate),
    'texts', (select jsonb_agg(to_jsonb(t) order by t.version_id)
      from public.document_version_texts t where version_id in (select id from versions)),
    'jobs', (select jsonb_agg(to_jsonb(j) order by j.id) from public.db_jobs j
      where payload->>'versionId' in (select id::text from versions))
  );
$$;

-- Fail after a prior edit, after both edits, or after activation respectively.
-- Check the real text-cache/job triggers have already run at every failure site.
create function pg_temp.reject_review_publication() returns trigger language plpgsql as $$
declare
  stage text := tg_argv[0];
  version uuid;
begin
  if current_setting('test.review_publication_failure', true) is distinct from stage then
    return new;
  end if;
  if stage = 'edit_insert' then
    if new.change_id <> 'replace-terms' then return new; end if;
    version := new.version_id;
  elsif stage = 'activation' then
    version := new.current_version_id;
  else
    version := new.edited_version_id;
    assert (select current_version_id = version from public.documents where id = new.document_id),
      'final run failure must occur after activation';
  end if;
  assert exists(select 1 from public.document_version_texts where version_id = version),
    'text-cache trigger ran before failure';
  assert exists(select 1 from public.db_jobs
    where kind = 'document.extract_text' and payload->>'versionId' = version::text),
    'text-job trigger ran before failure';
  assert (select count(*) = case when stage = 'edit_insert' then 1 else 2 end
    from public.document_edits where version_id = version), 'earlier edit writes reached';
  raise exception 'publication_test_%', stage;
end;
$$;
create trigger publication_test_edit before insert on public.document_edits
for each row execute function pg_temp.reject_review_publication('edit_insert');
create trigger publication_test_activation before update of current_version_id on public.documents
for each row execute function pg_temp.reject_review_publication('activation');
create trigger publication_test_run before update of status on public.playbook_runs
for each row execute function pg_temp.reject_review_publication('final_run_update');

do $$
declare
  actor_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  actor text := actor_id::text;
  other_actor text := other_id::text;
  job uuid;
  token uuid;
  job_identity jsonb;
  source_path text;
  book uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  winner uuid := gen_random_uuid();
  later uuid := gen_random_uuid();
  review uuid := gen_random_uuid();
  winner_run uuid := review;
  edit_one uuid := gen_random_uuid();
  edit_two uuid := gen_random_uuid();
  candidate uuid;
  -- Dev: findings carry a status (review_publish audits outcome counts).
  findings jsonb := '[{"rule":"terms","result":"issue","status":"unacceptable"},
    {"rule":"unmatched","result":"skipped","status":"acceptable"},
    {"rule":"law","result":"issue","status":"missing_required"}]';
  edits jsonb;
  version_input jsonb;
  expected_findings jsonb;
  annotation jsonb;
  result jsonb;
  saved_winner jsonb;
  before_run jsonb;
  before_document jsonb;
  test_case text;
  signature text := 'public.publish_playbook_review(uuid,text,text,jsonb,uuid,uuid,text,jsonb,jsonb,jsonb)';
begin
  assert not has_function_privilege('web_anon', signature, 'EXECUTE'), 'anonymous publication forbidden';
  assert not has_function_privilege('authenticated', signature, 'EXECUTE'), 'client publication forbidden';
  assert has_function_privilege('service_role', signature, 'EXECUTE'), 'service publication permitted';
  assert has_function_privilege('tenant_app', signature, 'EXECUTE'), 'tenant request client permitted';
  assert (select pg_get_userbyid(proowner) = 'tenant_definer' from pg_proc
    where oid = signature::regprocedure), 'owned by tenant_definer';
  assert not exists(select 1 from app.tenant_rls_gaps()), 'no tenant RLS gaps';

  perform set_config('request.jwt.claims', '{"tenant_id":"t-review-publication"}', true);
  insert into public.tenants(tenant_id) values('t-review-publication');
  insert into public.user_profiles(user_id, email) values
    (actor_id, 'review-publication@example.invalid'), (other_id, 'review-other@example.invalid');
  insert into public.playbooks(id, user_id, name, content_json)
    values(book, actor, 'Publication test', '{}');
  insert into public.documents(id, user_id) values(doc, actor);
  perform public.create_document_version(doc, jsonb_build_object(
    'id', source, 'version_number', 1, 'filename', 'source.docx', 'file_type', 'docx',
    'source', 'upload', 'storage_path', 'test/review-source.docx'));
  insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
    model, review_mode, status, started_at, error)
    values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'old error');
  version_input := jsonb_build_object('id', winner, 'filename', 'review.docx',
    'file_type', 'docx', 'source', 'assistant_edit', 'storage_path', 'test/review-result.docx',
    'size_bytes', 123, 'page_count', 2);
  -- Deliberately reverse finding order and omit optional fields from one edit.
  edits := jsonb_build_array(
    jsonb_build_object('id', edit_two, 'finding_index', 2, 'change_id', 'insert-law'),
    jsonb_build_object('id', edit_one, 'finding_index', 0, 'change_id', 'replace-terms',
      'del_w_id', '12', 'ins_w_id', '13', 'deleted_text', 'old', 'inserted_text', 'new',
      'context_before', 'before', 'context_after', 'after', 'reason', 'Apply the rule'));
  expected_findings := jsonb_build_array(
    findings->0 || jsonb_build_object('edit', jsonb_build_object(
      'kind', 'edit', 'edit_id', edit_one, 'document_id', doc, 'version_id', winner,
      'version_number', 2, 'change_id', 'replace-terms', 'del_w_id', '12', 'ins_w_id', '13',
      'deleted_text', 'old', 'inserted_text', 'new', 'context_before', 'before',
      'context_after', 'after', 'reason', 'Apply the rule', 'status', 'pending')),
    findings->1,
    findings->2 || jsonb_build_object('edit', jsonb_build_object(
      'kind', 'edit', 'edit_id', edit_two, 'document_id', doc, 'version_id', winner,
      'version_number', 2, 'change_id', 'insert-law', 'deleted_text', '', 'inserted_text', '',
      'context_before', '', 'context_after', '', 'status', 'pending')));

  result := public.publish_playbook_review(review, actor, 'Saved review', findings,
    doc, source, 'test/review-source.docx', version_input, edits);
  assert result->>'disposition' = 'published', 'native publication';
  select to_jsonb(r) into saved_winner from public.playbook_runs r where id = review;
  assert result->'run' = saved_winner, 'return the durable run';
  assert saved_winner->'findings_json' = expected_findings, 'exact links and untouched skipped finding';
  assert saved_winner->>'status' = 'completed' and saved_winner->>'summary' = 'Saved review'
    and (saved_winner->>'edited_version_id')::uuid = winner and saved_winner->>'error' is null
    and saved_winner->>'completed_at' is not null
    and saved_winner->'completed_at' = saved_winner->'updated_at', 'complete run metadata';
  assert (select count(*) = 2 from public.document_versions where document_id = doc), 'one result version';
  assert (select current_version_id = winner from public.documents where id = doc), 'result activated';
  assert result->'version' = (select to_jsonb(v) from public.document_versions v where id = winner),
    'return the durable version';
  assert result->'version' @> (version_input || jsonb_build_object('document_id', doc, 'version_number', 2)),
    'version metadata and allocated number';
  assert (select count(*) = 2 from public.document_edits where document_id = doc), 'one row per linked finding';
  for annotation in select value->'edit' from jsonb_array_elements(expected_findings) where value ? 'edit' loop
    assert exists(select 1 from public.document_edits e where id = (annotation->>'edit_id')::uuid
      and chat_message_id is null and resolved_at is null
      and jsonb_strip_nulls(to_jsonb(e) - array['id', 'created_at', 'chat_message_id', 'resolved_at', 'tenant_id'])
        = annotation - array['kind', 'edit_id', 'version_number', 'reason']), 'exact persisted edit';
  end loop;
  assert exists(select 1 from public.document_version_texts t join public.document_versions v on v.id = t.version_id
    where t.version_id = winner and t.source_revision = v.text_revision and t.status = 'pending'), 'real text cache created';
  assert (select count(*) = 1 from public.db_jobs
    where kind = 'document.extract_text' and payload->>'versionId' = winner::text), 'real extraction job created';

  -- A replay must return the saved winner even with different candidate content
  -- and a now-stale source. It must never reactivate over a newer user version.
  perform public.create_document_version(doc, jsonb_build_object(
    'id', later, 'filename', 'later.docx', 'file_type', 'docx', 'source', 'user_upload',
    'storage_path', 'test/review-later.docx'));
  candidate := gen_random_uuid();
  version_input := version_input || jsonb_build_object('id', candidate);
  edits := jsonb_set(jsonb_set(edits, '{0,id}', to_jsonb(gen_random_uuid())), '{1,id}', to_jsonb(gen_random_uuid()));
  before_document := pg_temp.review_document_state(doc, candidate);
  result := public.publish_playbook_review(winner_run, actor, 'Ignored replay', findings,
    doc, source, 'test/review-source.docx', version_input, edits);
  assert result = jsonb_build_object('disposition', 'existing', 'run', saved_winner), 'replay returns saved winner';
  assert pg_temp.review_document_state(doc, candidate) = before_document, 'replay makes no document writes';
  assert (select to_jsonb(r) = saved_winner from public.playbook_runs r where id = winner_run), 'replay preserves run';

  review := gen_random_uuid();
  insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
    model, review_mode, status, started_at)
    values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now());
  foreach test_case in array array['missing', 'wrong_owner', 'terminal'] loop
    if test_case = 'terminal' then
      update public.playbook_runs set status = 'failed', error = 'Already failed' where id = review;
    end if;
    select to_jsonb(r) into before_run from public.playbook_runs r where id = review;
    result := public.publish_playbook_review(
      case when test_case = 'missing' then gen_random_uuid() else review end,
      case when test_case = 'wrong_owner' then other_actor else actor end,
      'Must not publish', findings, doc, later, 'test/review-later.docx', version_input, edits);
    assert result = case when test_case = 'terminal'
      then jsonb_build_object('disposition', 'terminal', 'run', before_run)
      else jsonb_build_object('disposition', 'missing') end, 'missing/owner/terminal guard';
    assert (select to_jsonb(r) = before_run from public.playbook_runs r where id = review), 'guard preserves run';
    assert pg_temp.review_document_state(doc, candidate) = before_document, 'guard makes no document writes';
  end loop;

  -- Both a changed pointer and in-place source-byte replacement fall back to
  -- unlinked text-only findings, without versions, edits, cache rows or jobs.
  foreach test_case in array array['pointer', 'bytes'] loop
    if test_case = 'bytes' then
      update public.document_versions set storage_path = 'test/review-replaced.docx' where id = later;
    end if;
    review := gen_random_uuid();
    insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
      model, review_mode, status, started_at, error)
      values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'old error');
    before_document := pg_temp.review_document_state(doc, candidate);
    result := public.publish_playbook_review(review, actor, 'Source changed', findings, doc,
      case when test_case = 'pointer' then source else later end,
      case when test_case = 'pointer' then 'test/review-source.docx' else 'test/review-later.docx' end,
      version_input, edits);
    assert result->>'disposition' = 'source_changed' and result->'version' = 'null'::jsonb, 'source conflict disposition';
    assert result->'run' = (select to_jsonb(r) from public.playbook_runs r where id = review), 'durable conflict result';
    assert result->'run'->'findings_json' = findings and result->'run'->>'edited_version_id' is null
      and result->'run'->>'status' = 'completed' and result->'run'->>'summary' = 'Source changed'
      and result->'run'->>'error' is null and result->'run'->>'completed_at' is not null,
      'source conflict saves only unlinked findings';
    assert pg_temp.review_document_state(doc, candidate) = before_document, 'source conflict leaves no debris';
  end loop;

  foreach test_case in array array['edit_insert', 'activation', 'final_run_update'] loop
    review := gen_random_uuid();
    candidate := gen_random_uuid();
    version_input := version_input || jsonb_build_object('id', candidate);
    insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
      model, review_mode, status, started_at, summary, findings_json, error)
      values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'Before', '[]', 'Before error');
    select to_jsonb(r) into before_run from public.playbook_runs r where id = review;
    before_document := pg_temp.review_document_state(doc, candidate);
    perform set_config('test.review_publication_failure', test_case, true);
    begin
      perform public.publish_playbook_review(review, actor, 'Must roll back', findings,
        doc, later, 'test/review-replaced.docx', version_input, edits);
      raise exception 'expected publication failure was not raised';
    exception when raise_exception then
      if sqlerrm <> 'publication_test_' || test_case then raise; end if;
    end;
    perform set_config('test.review_publication_failure', '', true);
    assert (select to_jsonb(r) = before_run from public.playbook_runs r where id = review), 'entire run write rolls back';
    assert pg_temp.review_document_state(doc, candidate) = before_document,
      'version, edits, activation, text cache and extraction jobs all roll back';
  end loop;

  -- Dev job mode: a worker-claimed review publishes through the db_jobs claim
  -- fence, mutate_playbook_job document_check, the fenced
  -- create_document_version and mutate_playbook_job review_publish, all in
  -- this one transaction.
  doc := gen_random_uuid();
  source := gen_random_uuid();
  insert into public.documents(id, user_id) values(doc, actor);
  perform public.create_document_version(doc, jsonb_build_object(
    'id', source, 'version_number', 1, 'filename', 'source.docx', 'file_type', 'docx',
    'source', 'upload', 'storage_path', 'test/job-source.docx'));
  source_path := 'test/job-source.docx';
  foreach test_case in array array['published', 'existing', 'lease_lost', 'wrong_token',
    'conflict', 'conflict_text_only', 'forbidden', 'failed_before_publish',
    'edit_insert', 'activation', 'final_run_update'] loop
    if test_case <> 'existing' then
      review := gen_random_uuid();
      job := gen_random_uuid();
      token := gen_random_uuid();
      insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
        model, review_mode, status, started_at)
        values(review, book, actor, doc, '{"name":"Publication test"}', 'synthetic', 'strict', 'running', now());
      insert into public.db_jobs(id, kind, payload, status, attempts, claim_token, lease_expires_at)
        values(job, 'playbook.review', jsonb_build_object('runId', review, 'userId', actor,
          'userEmail', 'review-publication@example.invalid', 'orgId', null,
          'expectedVersion', jsonb_build_object('id', source, 'storagePath', source_path)),
          'running', 1, token, now() + interval '5 minutes');
    end if;
    job_identity := jsonb_build_object('id', job, 'attempt', 1,
      'token', case when test_case = 'wrong_token' then gen_random_uuid() else token end);
    candidate := gen_random_uuid();
    version_input := version_input || jsonb_build_object('id', candidate);
    edits := jsonb_set(jsonb_set(edits, '{0,id}', to_jsonb(gen_random_uuid())), '{1,id}', to_jsonb(gen_random_uuid()));
    if test_case = 'lease_lost' then
      update public.db_jobs set lease_expires_at = now() - interval '1 second' where id = job;
    elsif test_case = 'forbidden' then
      update public.documents set user_id = other_actor where id = doc;
    elsif test_case = 'conflict' then
      -- The user uploads a newer version while the review runs.
      perform public.create_document_version(doc, jsonb_build_object(
        'id', gen_random_uuid(), 'filename', 'later.docx', 'file_type', 'docx',
        'source', 'user_upload', 'storage_path', 'test/job-later.docx'));
    elsif test_case = 'failed_before_publish' then
      -- A review that fails before publishing is recorded through the fence;
      -- a publication arriving afterwards finds it terminal.
      assert public.mutate_playbook_job(job, 1, token, 'failure', review,
        '{"error":"The review could not be completed. Run it again."}')->>'result' = 'updated',
        'failure recorded through the fence';
    end if;
    select to_jsonb(r) into before_run from public.playbook_runs r where id = review;
    before_document := pg_temp.review_document_state(doc, candidate)
      || jsonb_build_object('audit', (select count(*) from public.audit_events where detail->>'run_id' = review::text));
    if test_case in ('edit_insert', 'activation', 'final_run_update') then
      perform set_config('test.review_publication_failure', test_case, true);
      begin
        perform public.publish_playbook_review(review, actor, 'Must roll back', findings,
          doc, source, source_path, version_input, edits, job_identity);
        raise exception 'expected job publication failure was not raised';
      exception when raise_exception then
        if sqlerrm <> 'publication_test_' || test_case then raise; end if;
      end;
      perform set_config('test.review_publication_failure', '', true);
    elsif test_case in ('lease_lost', 'wrong_token') then
      -- A stopped or superseded worker's late publication: the claim fence
      -- refuses it as a 40001 rollback with nothing written.
      begin
        perform public.publish_playbook_review(review, actor, 'Must not publish', findings,
          doc, source, source_path, version_input, edits, job_identity);
        raise exception 'expected claim loss was not raised';
      exception when serialization_failure then
        assert sqlerrm = 'playbook_claim_lost', 'claim loss is a 40001 rollback';
      end;
    elsif test_case = 'conflict_text_only' then
      -- Dev's review_publish refuses a text-only completion once the pinned
      -- version is no longer current (kept: not upstream's source_changed).
      update public.documents set current_version_id = null where id = doc;
      before_document := pg_temp.review_document_state(doc, candidate)
        || jsonb_build_object('audit', (select count(*) from public.audit_events where detail->>'run_id' = review::text));
      result := public.publish_playbook_review(review, actor, 'Must not publish', findings,
        null, null, null, null, '[]'::jsonb, job_identity);
    else
      result := public.publish_playbook_review(review, actor,
        case when test_case = 'published' then 'Saved review' else 'Must not publish' end, findings,
        doc, source, source_path, version_input, edits, job_identity);
    end if;
    if test_case = 'published' then
      assert result->>'disposition' = 'published', 'job publication';
      select to_jsonb(r) into saved_winner from public.playbook_runs r where id = review;
      assert result->'run' = saved_winner, 'job: durable run returned';
      assert saved_winner->>'status' = 'completed' and saved_winner->>'summary' = 'Saved review'
        and (saved_winner->>'edited_version_id')::uuid = candidate, 'job: run completed with its version';
      assert (select current_version_id = candidate from public.documents where id = doc), 'job: activated';
      assert (select count(*) = 2 from public.document_edits where version_id = candidate), 'job: edit rows';
      for annotation in select value->'edit' from jsonb_array_elements(saved_winner->'findings_json') where value ? 'edit' loop
        assert exists(select 1 from public.document_edits e where e.id = (annotation->>'edit_id')::uuid
          and e.version_id = candidate and e.change_id = annotation->>'change_id'), 'job: finding linked to its edit row';
      end loop;
      assert (select count(*) = 2 from jsonb_array_elements(saved_winner->'findings_json') where value ? 'edit'),
        'job: both edits linked';
      assert (select count(*) = 1 from public.audit_events where action = 'playbook.run' and status = 'completed'
        and detail->>'run_id' = review::text and user_id = actor), 'job: SQL audit row in the same transaction';
      assert exists(select 1 from public.document_version_texts where version_id = candidate), 'job: text cache queued';
      -- Later cases pin the new version.
      source := candidate;
      source_path := version_input->>'storage_path';
    elsif test_case = 'existing' then
      assert result->>'disposition' = 'existing' and result->'run' = saved_winner, 'job replay returns the saved run';
    elsif test_case in ('conflict', 'conflict_text_only') then
      assert result = '{"disposition":"conflict"}'::jsonb, 'job: changed source is a conflict ' || test_case;
    elsif test_case = 'forbidden' then
      assert result = '{"disposition":"forbidden"}'::jsonb, 'job: lost document access refuses';
    elsif test_case = 'failed_before_publish' then
      assert result->>'disposition' = 'terminal' and result->'run'->>'status' = 'failed', 'job: failed run stays failed';
    end if;
    if test_case <> 'published' then
      assert (select to_jsonb(r) = before_run from public.playbook_runs r where id = review), 'job: run untouched ' || test_case;
      assert pg_temp.review_document_state(doc, candidate)
        || jsonb_build_object('audit', (select count(*) from public.audit_events where detail->>'run_id' = review::text))
        = before_document, 'job: no document or audit writes ' || test_case;
    end if;
    if test_case = 'forbidden' then
      update public.documents set user_id = actor where id = doc;
    elsif test_case in ('conflict', 'conflict_text_only') then
      update public.documents set current_version_id = source where id = doc;
    end if;
  end loop;

  -- Another tenant cannot see the run at all.
  perform set_config('request.jwt.claims', '{"tenant_id":"t-review-other"}', true);
  insert into public.tenants(tenant_id) values('t-review-other');
  result := public.publish_playbook_review(winner_run, actor, 'Other tenant', findings);
  assert result = '{"disposition":"missing"}'::jsonb, 'tenant RLS hides another tenant''s run';
end;
$$;
rollback;
\echo Playbook review publication transaction checks passed.
