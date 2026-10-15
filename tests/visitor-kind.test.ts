import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Database } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import * as research from "../src/lib/research/service";
import { declareVisitorKind, visitorKindStatus } from "../src/lib/research/visitor-kind";
import { snapshotSummarySchema } from "../scripts/lib/evidence-snapshot";

const pg = new PGlite();
const db = drizzle(pg, { schema }) as unknown as Database;
const start = (mode: "strict" | "selective" = "selective") =>
  research.startRun(db, "test-user", "login-1", "northstar", mode);
const submission = (sessionId: string, variant = "v5", choice = "ai_assistant") => ({
  sessionId,
  variant,
  choice,
});
const audit = (sessionId: string) =>
  db.select().from(schema.events).where(eq(schema.events.sessionId, sessionId));
const protectedState = async (session: schema.ResearchSession) => ({
  session: await db.select().from(schema.sessions).where(eq(schema.sessions.id, session.id)),
  run: await db.select().from(schema.runs).where(eq(schema.runs.id, session.runId)),
  tickets: await research.listTickets(db, session),
});

before(async () => {
  await pg.exec(await readFile("scripts/schema.sql", "utf8"));
});
after(async () => {
  await pg.close();
});

test("an explicit choice appends a session-bound event without changing registration, signals or tickets", async () => {
  const { session } = await start();
  const before = await protectedState(session);
  const result = await declareVisitorKind(db, session, submission(session.id));
  assert.equal(result.status, 200);
  assert.ok("accepted" in result && result.accepted);
  assert.equal(result.sessionId, session.id);
  const rows = (await audit(session.id)).filter((e) => e.type === "visitor_kind_declared");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.eventId);
  assert.equal(rows[0].runId, session.runId);
  assert.equal(rows[0].origin, "server");
  assert.deepEqual(rows[0].data, {
    variant: "v5",
    choice: "ai_assistant",
    evidence: "self_reported",
  });
  assert.deepEqual(await protectedState(session), before);
  const status = await research.registrationStatus(db, session);
  assert.equal(status.accepted, false);
  assert.equal(status.required, false);
  assert.equal(status.declaration, null);
});

test("person and withheld choices are retained literally and never manufacture identity fields", async () => {
  const { session } = await start();
  for (const choice of ["person", "prefer_not_to_say"]) {
    const result = await declareVisitorKind(db, session, submission(session.id, "v6", choice));
    assert.equal(result.status, 200);
    const latest = await visitorKindStatus(db, session, "v6");
    assert.ok("accepted" in latest && latest.accepted);
    assert.equal(latest.choice, choice);
    assert.ok("eventId" in result);
    assert.equal(latest.eventId, result.eventId);
  }
  const [stored] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, session.id));
  assert.equal(stored.declaration, null);
  assert.equal(stored.declaredPseudonym, null);
  assert.equal(stored.automated, false);
  assert.equal(stored.acceptedAt, null);
});

test("status uses the latest choice within the current session and requested variant", async () => {
  const { session } = await start();
  const other = (await start()).session;
  const empty = await visitorKindStatus(db, session, "v5");
  assert.ok("accepted" in empty && !empty.accepted);
  assert.equal(empty.choice, null);
  assert.equal(empty.eventId, null);
  await declareVisitorKind(db, session, submission(session.id));
  const otherVariant = await visitorKindStatus(db, session, "v6");
  assert.ok("accepted" in otherVariant && !otherVariant.accepted);
  await declareVisitorKind(db, session, submission(session.id, "v5", "person"));
  await declareVisitorKind(db, session, submission(session.id, "v6", "prefer_not_to_say"));
  await declareVisitorKind(db, other, submission(other.id));
  const v5 = await visitorKindStatus(db, session, "v5");
  const v6 = await visitorKindStatus(db, session, "v6");
  const otherV5 = await visitorKindStatus(db, other, "v5");
  assert.ok("choice" in v5 && "choice" in v6 && "choice" in otherV5);
  assert.equal(v5.choice, "person");
  assert.equal(v6.choice, "prefer_not_to_say");
  assert.equal(otherV5.choice, "ai_assistant");
  assert.notEqual(v5.eventId, v6.eventId);
  assert.notEqual(v5.eventId, otherV5.eventId);
});

test("invalid payloads and session mismatches add no classification events", async () => {
  const { session } = await start();
  const before = await audit(session.id);
  for (const invalid of [
    null,
    {},
    submission("not-a-uuid"),
    submission(session.id, "v4"),
    submission(session.id, "v5", "unknown"),
    { ...submission(session.id), agentName: "invented" },
    { variant: "v5", choice: "ai_assistant" },
    { sessionId: session.id, variant: "v5" },
  ]) {
    assert.deepEqual(await declareVisitorKind(db, session, invalid), {
      status: 422,
      code: "invalid_visitor_kind",
    });
  }
  assert.deepEqual(await declareVisitorKind(db, session, submission(randomUUID())), {
    status: 403,
    code: "session_mismatch",
  });
  assert.deepEqual(await audit(session.id), before);
  for (const invalid of [null, "v4", "v5' OR true --"]) {
    assert.deepEqual(await visitorKindStatus(db, session, invalid), {
      status: 422,
      code: "invalid_visitor_kind_variant",
    });
  }
});

test("stale contexts cannot append or read classifications after close, expiry or a login change", async () => {
  for (const scenario of ["closed", "expired", "idle", "login", "missing"] as const) {
    const { session } = await start();
    await declareVisitorKind(db, session, submission(session.id));
    let now = new Date();
    if (scenario === "closed") await research.closeSession(db, session);
    if (scenario === "expired") now = new Date(session.expiresAt.getTime() + 1);
    if (scenario === "idle") now = new Date(session.lastSeenAt.getTime() + 30 * 60 * 1000);
    if (scenario === "login")
      await db
        .update(schema.sessions)
        .set({ authSessionId: "changed-login" })
        .where(eq(schema.sessions.id, session.id));
    if (scenario === "missing")
      await db.delete(schema.runs).where(eq(schema.runs.id, session.runId));
    const before = await audit(session.id);
    const failure = { status: 401, code: "session_expired" };
    assert.deepEqual(await declareVisitorKind(db, session, submission(session.id), now), failure);
    assert.deepEqual(await visitorKindStatus(db, session, "v5", now), failure);
    assert.deepEqual(await audit(session.id), before);
  }
});

test("status polling does not mutate state, add evidence or extend session lifetime", async () => {
  const { session } = await start();
  await declareVisitorKind(db, session, submission(session.id));
  const before = await protectedState(session);
  const beforeAudit = await audit(session.id);
  await visitorKindStatus(db, session, "v5", new Date(session.lastSeenAt.getTime() + 29 * 60000));
  assert.deepEqual(await protectedState(session), before);
  assert.deepEqual(await audit(session.id), beforeAudit);
  assert.equal(
    (
      await visitorKindStatus(
        db,
        session,
        "v5",
        new Date(session.lastSeenAt.getTime() + 31 * 60000),
      )
    ).status,
    401,
  );
});

test("a classification cannot satisfy strict registration or grant restricted ticket permissions", async () => {
  const { session } = await start("strict");
  await declareVisitorKind(db, session, submission(session.id, "v6"));
  assert.equal((await research.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
  assert.equal((await research.savePriority(db, session.id, "meridian", "Low", 0)).status, 403);
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
  await research.register(db, session.id, {
    agentName: "Existing declaration",
    actingFor: "R17",
    sources: ["current_website"],
  });
  const before = await protectedState(session);
  await declareVisitorKind(db, session, submission(session.id, "v6", "person"));
  assert.deepEqual(await protectedState(session), before);
});

test("snapshot exports retain only the declared classification fields and reject invalid choices", async () => {
  const { session } = await start();
  await declareVisitorKind(db, session, submission(session.id, "v5", "ai_assistant"));
  await declareVisitorKind(db, session, submission(session.id, "v6", "prefer_not_to_say"));
  const report = await research.summary(db, session.id);
  assert.ok(report);
  const contaminated = {
    ...report,
    events: report.events.map((event) => ({
      ...event,
      data: { ...event.data, cookies: "private-token", agentName: "private-name" },
    })),
  };
  const snapshot = snapshotSummarySchema.parse(contaminated);
  assert.equal(JSON.stringify(snapshot).includes("private-"), false);
  assert.deepEqual(
    snapshot.events
      .filter((event) => event.type === "visitor_kind_declared")
      .map((event) => event.data),
    [
      { variant: "v5", choice: "ai_assistant", evidence: "self_reported" },
      { variant: "v6", choice: "prefer_not_to_say", evidence: "self_reported" },
    ],
  );
  for (const invalid of [
    { variant: "v4", choice: "ai_assistant", evidence: "self_reported" },
    { variant: "v5", choice: "private-arbitrary-value", evidence: "self_reported" },
    { variant: "v5", choice: "person", evidence: "verified" },
    { variant: "v5", evidence: "self_reported" },
  ]) {
    assert.equal(
      snapshotSummarySchema.safeParse({
        ...report,
        events: report.events.map((event) =>
          event.type === "visitor_kind_declared" ? { ...event, data: invalid } : event,
        ),
      }).success,
      false,
    );
  }
});

test("legacy V4 snapshot events keep their existing projection without classification fields", async () => {
  const { session } = await start();
  await research.requireRegistration(db, session);
  const report = await research.summary(db, session.id);
  const snapshot = snapshotSummarySchema.parse(report);
  assert.deepEqual(
    snapshot.events.find((event) => event.type === "registration_requirement_enabled")?.data,
    { mode: "strict" },
  );
});
