-- Preserve file keys across partial account-erasure attempts. The erasure job
-- deletes version rows before bytes, so a retry needs an independent outbox.
CREATE TABLE IF NOT EXISTS public.account_erasure_storage_paths (
    user_id TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    PRIMARY KEY (user_id, storage_path)
);

REVOKE ALL ON TABLE public.account_erasure_storage_paths FROM PUBLIC, web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_erasure_storage_paths TO service_role;
