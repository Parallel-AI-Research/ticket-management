import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("session lookup preserves column grants, invoking-role RLS, and immediate revocation", async () => {
  const pg = new PGlite();
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000002";
  const otherUserId = "00000000-0000-4000-8000-000000000003";
  const lookup = (principalId = userId) =>
    pg.query<{ id: string }>(
      "select id from research.auth_session_lookup where id = $1::uuid and user_id = $2::uuid limit 1",
      [sessionId, principalId],
    );

  try {
    await pg.exec(`
      CREATE ROLE research_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE SCHEMA research;
      CREATE TABLE auth.sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        refresh_token text NOT NULL
      );
      ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA research TO research_app;
      GRANT SELECT (id, user_id) ON auth.sessions TO research_app;
      CREATE POLICY research_server_session_lookup ON auth.sessions
        FOR SELECT TO research_app USING (true);
    `);
    await pg.query("insert into auth.sessions values ($1, $2, 'synthetic-private-value')", [
      sessionId,
      userId,
    ]);
    const [migration] = (await readdir("supabase/migrations")).filter((name) =>
      name.endsWith("_add_auth_session_lookup_view.sql"),
    );
    assert.ok(migration);
    await pg.exec(await readFile(`supabase/migrations/${migration}`, "utf8"));

    const privileges = await pg.query<{ auth_usage: boolean; token_select: boolean }>(`
      select has_schema_privilege('research_app', 'auth', 'USAGE') as auth_usage,
        has_column_privilege('research_app', 'auth.sessions', 'refresh_token', 'SELECT') as token_select
    `);
    assert.deepEqual(privileges.rows, [{ auth_usage: false, token_select: false }]);
    await pg.exec("SET ROLE research_app");
    await assert.rejects(
      pg.query("select id from auth.sessions"),
      /permission denied for schema auth/,
    );
    assert.deepEqual((await lookup()).rows, [{ id: sessionId }]);
    assert.deepEqual((await lookup(otherUserId)).rows, []);
    assert.deepEqual((await pg.query("select * from research.auth_session_lookup")).rows, [
      { id: sessionId, user_id: userId },
    ]);

    await pg.exec(`
      RESET ROLE;
      DROP POLICY research_server_session_lookup ON auth.sessions;
      SET ROLE research_app;
    `);
    assert.deepEqual((await lookup()).rows, []);

    await pg.exec(`
      RESET ROLE;
      CREATE POLICY research_server_session_lookup ON auth.sessions
        FOR SELECT TO research_app USING (true);
      SET ROLE research_app;
    `);
    assert.deepEqual((await lookup()).rows, [{ id: sessionId }]);
    await pg.exec("RESET ROLE");
    await pg.query("delete from auth.sessions where id = $1::uuid", [sessionId]);
    await pg.exec("SET ROLE research_app");
    assert.deepEqual((await lookup()).rows, []);
  } finally {
    await pg.close();
  }
});
