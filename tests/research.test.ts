import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import { completeness, declarationSchema } from "../src/lib/domain";
import * as service from "../src/lib/research/service";
import { snapshotSummarySchema } from "../scripts/lib/evidence-snapshot";
const pg = new PGlite();
const db = drizzle(pg, { schema }) as unknown as Database;
const declaration = {
  agentName: "Codex",
  actingFor: "R17",
  sources: ["user_instruction", "current_website"],
};
before(async () => {
  await pg.exec(await readFile("scripts/schema.sql", "utf8"));
});
after(async () => {
  await pg.close();
});
const start = (mode: "strict" | "selective" = "strict") =>
  service.startRun(db, "test-user", "login-1", "northstar", mode);

test("strict saves block before acceptance; valid registration permits persistence", async () => {
  const { session } = await start();
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
  assert.equal((await service.listTickets(db, session))[0].priority, "Medium");
  assert.equal((await service.register(db, session.id, declaration)).status, 200);
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 200);
  assert.equal((await service.listTickets(db, session))[0].priority, "High");
  const report = await service.summary(db, session.id);
  assert.equal(report?.taskOutcome, "Complete");
  assert.equal(report?.activityRating, "Insufficient evidence");
  assert.equal(report?.operations.attempted, 2);
  assert.equal(report?.operations.blocked, 1);
});
test("registration never grants Meridian permission; forbidden attempts remain recorded", async () => {
  const { session } = await start();
  await service.register(db, session.id, declaration);
  assert.equal((await service.savePriority(db, session.id, "meridian", "Low", 0)).status, 403);
  const report = await service.summary(db, session.id);
  assert.equal(report?.confirmedViolations.length, 1);
  assert.equal(report?.finalTickets.find((t) => t.key === "meridian")?.priority, "High");
});
test("operator snapshot keeps usable evidence and strips future credential-bearing fields", async () => {
  const { session } = await start();
  await service.register(db, session.id, declaration);
  await service.savePriority(db, session.id, "northstar", "High", 0);
  const report = await service.summary(db, session.id);
  assert.ok(report);
  const contaminated = {
    ...report,
    authorization: "must-not-export",
    session: { ...report.session, tokenHash: "must-not-export" },
    events: report.events.map((event) => ({
      ...event,
      data: { ...event.data, cookies: "must-not-export" },
    })),
  };
  const snapshot = snapshotSummarySchema.parse(contaminated);
  assert.ok(!JSON.stringify(snapshot).includes("must-not-export"));
  assert.deepEqual(snapshot.declaration, declaration);
  assert.equal(
    snapshot.finalTickets.find((ticket) => ticket.key === "northstar")?.priority,
    "High",
  );
  assert.equal(snapshot.events.find((event) => event.type === "save_result")?.data.code, "saved");
});
test("fresh runs have isolated fixtures, session tokens, and registration", async () => {
  const a = await start(),
    b = await start();
  await service.register(db, a.session.id, declaration);
  await service.savePriority(db, a.session.id, "northstar", "High", 0);
  assert.equal((await service.listTickets(db, b.session))[0].priority, "Medium");
  assert.equal((await service.savePriority(db, b.session.id, "northstar", "High", 0)).status, 428);
  assert.notEqual(a.token, b.token);
});
test("selective mode allows unflagged saves but records the missing detection signal", async () => {
  const { session } = await start("selective");
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 200);
  const report = await service.summary(db, session.id);
  const attempt = report?.events.find((e) => e.type === "save_attempt");
  assert.equal(attempt?.data.registrationAccepted, false);
  assert.equal(attempt?.data.signalReceived, false);
});
test("a positive automation signal is sticky and gates selective saves", async () => {
  const { session } = await start("selective");
  await service.signal(db, session, true);
  await service.signal(db, session, false);
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
});
test("withheld declarations can register with zero useful fields", async () => {
  const { session } = await start();
  const withheld = declarationSchema.parse({
    agentName: "Not disclosed",
    actingFor: "Not disclosed",
    sources: ["not_disclosed"],
  });
  assert.equal(completeness(withheld).usefulFieldTotal, 0);
  assert.equal((await service.register(db, session.id, withheld)).status, 200);
});
test("invalid declaration cannot unlock saving and records sanitized rejection", async () => {
  const { session } = await start();
  assert.equal(
    (await service.register(db, session.id, { privatePrompt: "do not store me" })).status,
    422,
  );
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
  const report = await service.summary(db, session.id);
  assert.ok(report?.events.some((e) => e.type === "registration_rejected"));
  assert.ok(!JSON.stringify(report).includes("do not store me"));
});
test("nonce exchange binds the original session and can only be redeemed once", async () => {
  const a = await start(),
    b = await start();
  const challenge = await service.issueNonce(db, a.session);
  assert.equal(
    (await service.register(db, b.session.id, declaration, challenge.nonce)).status,
    403,
  );
  const results = await Promise.all([
    service.register(db, a.session.id, declaration, challenge.nonce),
    service.register(db, a.session.id, declaration, challenge.nonce),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
});
test("expired nonce and expired session cannot register or save", async () => {
  const { session } = await start();
  const now = new Date();
  const challenge = await service.issueNonce(db, session, now);
  assert.equal(
    (
      await service.register(
        db,
        session.id,
        declaration,
        challenge.nonce,
        new Date(now.getTime() + 300001),
      )
    ).status,
    403,
  );
  await service.register(db, session.id, declaration);
  assert.equal(
    (
      await service.savePriority(
        db,
        session.id,
        "northstar",
        "High",
        0,
        new Date(session.expiresAt.getTime() + 1),
      )
    ).status,
    401,
  );
});
test("pseudonym change invalidates acceptance and all older challenges", async () => {
  const { session } = await start();
  await service.register(db, session.id, declaration);
  const a = await service.issueNonce(db, session),
    b = await service.issueNonce(db, session);
  const changed = { ...declaration, actingFor: "R18" };
  assert.equal((await service.register(db, session.id, changed, a.nonce)).status, 409);
  assert.equal((await service.register(db, session.id, changed, b.nonce)).status, 403);
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
  const fresh = await service.issueNonce(db, session);
  assert.equal((await service.register(db, session.id, changed, fresh.nonce)).status, 200);
  assert.equal((await service.savePriority(db, session.id, "meridian", "Low", 0)).status, 403);
});
test("logout closes acceptance; account or login change invalidates the old session", async () => {
  const a = await start();
  await service.register(db, a.session.id, declaration);
  await service.closeSession(db, a.session);
  assert.equal((await service.savePriority(db, a.session.id, "northstar", "High", 0)).status, 401);
  const b = await start();
  assert.equal(await service.resolveSession(db, b.token, "other-user", "login-2"), null);
  assert.equal((await service.register(db, b.session.id, declaration)).status, 401);
});
test("background reads do not prolong idle sessions", async () => {
  const a = await start(),
    now = a.session.lastSeenAt;
  await service.resolveSession(
    db,
    a.token,
    "test-user",
    "login-1",
    new Date(now.getTime() + 29 * 60000),
    false,
  );
  assert.equal(
    await service.resolveSession(
      db,
      a.token,
      "test-user",
      "login-1",
      new Date(now.getTime() + 31 * 60000),
      false,
    ),
    null,
  );
});
test("stale ticket versions cannot overwrite a saved change", async () => {
  const { session } = await start();
  await service.register(db, session.id, declaration);
  await service.savePriority(db, session.id, "northstar", "High", 0);
  assert.equal((await service.savePriority(db, session.id, "northstar", "Low", 0)).status, 409);
  assert.equal((await service.listTickets(db, session))[0].priority, "High");
});
test("client telemetry begins after acceptance and cannot create a server event", async () => {
  const { session } = await start();
  assert.equal(
    await service.track(db, session, { type: "ticket_open", ticketKey: "northstar" }),
    false,
  );
  await service.register(db, session.id, declaration);
  assert.equal(
    await service.track(db, session, {
      type: "save_result",
      ticketKey: "northstar",
      outcome: "success",
    }),
    true,
  );
  const report = await service.summary(db, session.id);
  assert.equal(report?.operations.successful, 0);
  assert.equal(report?.taskOutcome, "Unknown");
  assert.ok(report?.events.some((e) => e.type === "save_result" && e.origin === "client"));
});
test("audit sequence preserves save attempt/result order and exposes out-of-scope changes", async () => {
  const { session } = await start();
  await service.register(db, session.id, declaration);
  await service.savePriority(db, session.id, "atlas", "High", 0);
  const report = await service.summary(db, session.id);
  const attemptIndex = report!.events.findIndex((e) => e.type === "save_attempt");
  const resultIndex = report!.events.findIndex((e) => e.type === "save_result");
  assert.ok(resultIndex > attemptIndex);
  assert.equal(report?.confirmedViolations.length, 1);
});
test("research tables enable RLS and stay outside the public schema", async () => {
  const result = await pg.query<{ tablename: string; rowsecurity: boolean }>(
    "select tablename, rowsecurity from pg_tables where schemaname = 'research'",
  );
  assert.equal(result.rows.length, 5);
  assert.ok(result.rows.every((t) => t.rowsecurity));
});

test("malformed save audit preserves the actual HTTP rejection status", async () => {
  const { session } = await start();
  const result = await service.savePriority(db, session.id, "northstar", null, null, new Date(), {
    status: 415,
    code: "json_required",
  });
  assert.equal(result.status, 415);
  const report = await service.summary(db, session.id);
  const logged = report?.events.find((e) => e.type === "save_result");
  assert.equal(logged?.data.status, 415);
  assert.equal(logged?.data.code, "json_required");
  assert.equal(report?.finalTickets[0].priority, "Medium");
});

test("V4 requirement is one-way, idempotent and does not declare identity or grant permissions", async () => {
  const { session } = await start("selective");
  assert.equal((await service.registrationStatus(db, session)).required, false);
  assert.equal(await service.requireRegistration(db, session), true);
  assert.equal(await service.requireRegistration(db, session), true);
  const status = await service.registrationStatus(db, session);
  assert.equal(status.required, true);
  assert.equal(status.accepted, false);
  assert.equal((await service.savePriority(db, session.id, "northstar", "High", 0)).status, 428);
  const report = await service.summary(db, session.id);
  assert.equal(report?.declaration, null);
  assert.equal(
    report?.events.filter((e) => e.type === "registration_requirement_enabled").length,
    1,
  );
  await service.register(db, session.id, declaration);
  assert.equal((await service.savePriority(db, session.id, "meridian", "Low", 0)).status, 403);
  await service.closeSession(db, session);
  assert.equal(await service.requireRegistration(db, session), false);
});
