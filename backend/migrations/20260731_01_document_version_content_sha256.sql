-- Migration date: 2026-07-31

-- Tamper-evidence: store a SHA-256 hex digest of each version's file bytes at
-- write time so a project export can prove a file matches what the workspace
-- actually held. Verification is then `shasum -a 256 <file>` against the value
-- recorded in the export manifest.
--
-- Nullable on purpose: rows written before this migration stay unhashed until
-- their bytes are next rewritten (in-place edit resolution, or version
-- replace). Backfilling legacy rows would mean streaming every stored object
-- out of R2, so it is deliberately left to a separate opt-in job rather than
-- folded into a schema migration.

alter table public.document_versions
  add column if not exists content_sha256 text;
