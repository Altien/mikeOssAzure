#requires -Version 7.0
# Verifies that migration 0018 supports migrate-before-promote and rollback:
# v0.3 can keep using annotations while v0.4 uses citations.

[CmdletBinding()]
param(
    [string]$PostgresContainer = "mike-postgres",
    [string]$PostgresUser = "mikeadmin"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$MigrationPath = Join-Path $RepoRoot "backend/migrations/0018_chat_message_citations.sql"
$RepairMigrationPath = Join-Path $RepoRoot "backend/migrations/0020_chat_message_citations_compatibility.sql"
$LegacyDatabase = "mike_upgrade_contract"
$RenamedDatabase = "mike_upgrade_contract_renamed"

function Invoke-AdminSql([string]$Sql) {
    docker exec $PostgresContainer psql -U $PostgresUser -d postgres -v ON_ERROR_STOP=1 -c $Sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Postgres admin command failed." }
}

function Invoke-DatabaseSql([string]$Database, [string]$Sql) {
    $Sql | docker exec -i $PostgresContainer psql -U $PostgresUser -d $Database -v ON_ERROR_STOP=1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "SQL failed in $Database." }
}

function Apply-Migration([string]$Database) {
    Get-Content -Raw $MigrationPath |
        docker exec -i $PostgresContainer psql -U $PostgresUser -d $Database -v ON_ERROR_STOP=1 |
        Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Migration 0018 failed in $Database." }
}

function Apply-RepairMigration([string]$Database) {
    Get-Content -Raw $RepairMigrationPath |
        docker exec -i $PostgresContainer psql -U $PostgresUser -d $Database -v ON_ERROR_STOP=1 |
        Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Migration 0020 failed in $Database." }
}

function Query-Scalar([string]$Database, [string]$Sql) {
    $result = docker exec $PostgresContainer psql -U $PostgresUser -d $Database -tAc $Sql
    if ($LASTEXITCODE -ne 0) { throw "Query failed in $Database." }
    return ($result ?? "").Trim()
}

try {
    Invoke-AdminSql "drop database if exists $LegacyDatabase"
    Invoke-AdminSql "drop database if exists $RenamedDatabase"
    Invoke-AdminSql "create database $LegacyDatabase"
    Invoke-AdminSql "create database $RenamedDatabase"

    Invoke-DatabaseSql $LegacyDatabase @'
create table public.chat_messages (
  id uuid primary key,
  annotations jsonb
);
insert into public.chat_messages (id, annotations)
values ('00000000-0000-0000-0000-000000000001', '[{"ref":1}]'::jsonb);
'@
    Apply-Migration $LegacyDatabase

    Invoke-DatabaseSql $LegacyDatabase @'
insert into public.chat_messages (id, citations)
values ('00000000-0000-0000-0000-000000000002', '[{"ref":2}]'::jsonb);

update public.chat_messages
set annotations = '[{"ref":3}]'::jsonb
where id = '00000000-0000-0000-0000-000000000001';

update public.chat_messages
set citations = '[{"ref":4}]'::jsonb
where id = '00000000-0000-0000-0000-000000000002';
'@

    $legacyContract = Query-Scalar $LegacyDatabase @'
select
  count(*) = 2
  and bool_and(annotations = citations)
  and count(*) filter (where annotations is not null) = 2
from public.chat_messages;
'@
    if ($legacyContract -ne "t") {
        throw "Old/new chat-message interfaces did not remain synchronized."
    }

    # Re-running the migration must be safe.
    Apply-Migration $LegacyDatabase

    # Repair contract for an environment where the earlier hard-rename version
    # of 0018 had already run before this compatibility fix was deployed.
    Invoke-DatabaseSql $RenamedDatabase @'
create table public.chat_messages (
  id uuid primary key,
  citations jsonb
);
insert into public.chat_messages (id, citations)
values ('00000000-0000-0000-0000-000000000003', '[{"ref":5}]'::jsonb);
'@
    Apply-RepairMigration $RenamedDatabase
    $repairContract = Query-Scalar $RenamedDatabase @'
select annotations = citations
from public.chat_messages
where id = '00000000-0000-0000-0000-000000000003';
'@
    if ($repairContract -ne "t") {
        throw "Migration did not repair an already-renamed environment."
    }

    Write-Host "[ok] v0.3 annotations and v0.4 citations coexist"
    Write-Host "[ok] writes from either version remain synchronized"
    Write-Host "[ok] earlier hard-rename deployments are repaired"
} finally {
    Invoke-AdminSql "drop database if exists $LegacyDatabase"
    Invoke-AdminSql "drop database if exists $RenamedDatabase"
}
