-- The Next.js server authenticates participants and enforces per-run access.
-- This role has no schema/role administration or RLS bypass permissions.
CREATE ROLE research_app LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

GRANT CONNECT ON DATABASE postgres TO research_app;
GRANT USAGE ON SCHEMA research TO research_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON research.runs, research.nonces TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.sessions, research.tickets TO research_app;
GRANT SELECT, INSERT ON research.events TO research_app;
GRANT USAGE ON SEQUENCE research.events_sequence_seq TO research_app;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['runs', 'sessions', 'tickets', 'events', 'nonces']
  LOOP
    EXECUTE format(
      'CREATE POLICY research_server_access ON research.%I FOR ALL TO research_app USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END $$;

-- Check session revocation without access to Auth tokens, emails, or passwords.
-- The later invoker-view migration makes these columns reachable without
-- requiring USAGE on Supabase's managed auth schema.
GRANT SELECT (id, user_id) ON auth.sessions TO research_app;
CREATE POLICY research_server_session_lookup ON auth.sessions
  FOR SELECT TO research_app USING (true);

-- Password provisioning is performed separately and never committed.
