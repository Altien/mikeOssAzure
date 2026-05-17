-- Adds the explicit document_ids list to tabular_reviews (upstream 4f33843,
-- "Update document UI, tabular reviews, and storage caching"). When set, a
-- review's document membership is taken from this jsonb array instead of
-- being inferred from tabular_cells / the owning project's documents.
-- NULL means "legacy review" — routes/tabular.ts falls back to the old
-- cell-derived membership for those rows.
--
-- 0000_initial.sql also carries the column (for fresh installs); this
-- migration brings existing databases up to date.

alter table public.tabular_reviews
  add column if not exists document_ids jsonb;
