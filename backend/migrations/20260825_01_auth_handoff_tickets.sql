-- Migration date: 2026-08-25
-- Adds short-lived, encrypted, one-time tickets used to transfer an OAuth
-- result from an Office dialog into the Word task pane without exposing the
-- underlying Supabase access or refresh tokens to JavaScript.

CREATE TABLE IF NOT EXISTS public.auth_handoff_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticket_hash text NOT NULL UNIQUE,
  request_id text NOT NULL,
  origin text NOT NULL,
  encrypted_session text NOT NULL,
  session_iv text NOT NULL,
  session_tag text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_handoff_tickets_expires
  ON public.auth_handoff_tickets(expires_at);

ALTER TABLE public.auth_handoff_tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.auth_handoff_tickets FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.auth_handoff_tickets
  TO service_role;
