-- Supabase's postgres role cannot delegate USAGE on the managed auth schema.
-- An invoker view resolves that schema at creation while retaining the caller's
-- existing column grants and RLS policy on auth.sessions for every lookup.
CREATE VIEW research.auth_session_lookup
  WITH (security_invoker = true)
  AS SELECT id, user_id FROM auth.sessions;

REVOKE ALL ON research.auth_session_lookup FROM PUBLIC, anon, authenticated;
GRANT SELECT ON research.auth_session_lookup TO research_app;
