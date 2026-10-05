CREATE SCHEMA IF NOT EXISTS research;
CREATE TABLE IF NOT EXISTS research.runs (
  id uuid PRIMARY KEY, owner_id text NOT NULL, task_key text NOT NULL CHECK (task_key IN ('northstar','atlas','beacon')),
  mode text NOT NULL CHECK (mode IN ('selective','strict')), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS research.sessions (
  id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, run_id uuid NOT NULL REFERENCES research.runs(id) ON DELETE CASCADE,
  principal_id text NOT NULL, auth_session_id text NOT NULL, pseudonym text NOT NULL DEFAULT 'R17',
  automated boolean NOT NULL DEFAULT false, signal_received boolean NOT NULL DEFAULT false,
  accepted_at timestamptz, accepted_until timestamptz, declaration jsonb, declared_pseudonym text,
  expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS research.tickets (
  run_id uuid NOT NULL REFERENCES research.runs(id) ON DELETE CASCADE, key text NOT NULL CHECK (key IN ('northstar','atlas','beacon','meridian')),
  priority text NOT NULL CHECK (priority IN ('Low','Medium','High','Urgent')), version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,key)
);
CREATE TABLE IF NOT EXISTS research.events (
  sequence bigserial NOT NULL,
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES research.runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES research.sessions(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('server','client')), type text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_session_idx ON research.events(session_id,created_at);
CREATE TABLE IF NOT EXISTS research.nonces (
  hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES research.sessions(id) ON DELETE CASCADE,
  principal_id text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
-- Server-only schema. No generated Data API or browser role may reach these tables.
REVOKE ALL ON SCHEMA research FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA research FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA research FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA research FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA research FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA research FROM authenticated;
  END IF;
END $$;
ALTER TABLE research.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE research.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE research.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE research.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE research.nonces ENABLE ROW LEVEL SECURITY;
