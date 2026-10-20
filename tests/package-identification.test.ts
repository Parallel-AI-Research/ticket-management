import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Database } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import * as research from "../src/lib/research/service";
import {
  checkPackageReceipt,
  issuePackageContext,
  packageMode,
  packageSessionBinding,
  packageSettings,
  recordPackageReceipt,
  type PackageMode,
} from "../src/lib/research/package-identification";
import { snapshotSummarySchema } from "../scripts/lib/evidence-snapshot";
import {
  evaluateEvidence,
  type EvidenceSummary,
  type IndependentTrace,
} from "../src/lib/research/evidence";

const pg = new PGlite();
const db = drizzle(pg, { schema }) as unknown as Database;
const settings = {
  siteId: "ticket-package-test",
  origin: "https://tickets.example",
  apiUrl: "https://collector.example",
  secret: "test-only-package-site-secret-00000000000000000000",
};
const env = {
  AGENT_ID_SITE_ID: settings.siteId,
  AGENT_ID_SITE_SECRET: settings.secret,
  AGENT_ID_API_URL: settings.apiUrl,
  APP_ORIGIN: settings.origin,
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
const choices = ["ai_assistant", "person", "prefer_not_to_say"] as const;
type Choice = (typeof choices)[number];
const start = (
  mode: PackageMode | null = "required",
  legacy: "selective" | "strict" = "selective",
) => research.startRun(db, "test-user", "login-1", "northstar", legacy, new Date(), mode);
const audit = (sessionId: string) =>
  db.select().from(schema.events).where(eq(schema.events.sessionId, sessionId));
const storedSession = async (id: string) =>
  (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)))[0];
const state = async (session: schema.ResearchSession) => ({
  session: await storedSession(session.id),
  tickets: await research.listTickets(db, session),
});

// Create collector-side fixtures from the published wire protocol. Production code
// verifies these through the installed package, never a test copy of its verifier.
function declaration(
  session: schema.ResearchSession,
  mode: PackageMode = "required",
  choice: Choice = "ai_assistant",
  overrides: Record<string, unknown> = {},
  secret = settings.secret,
  now = new Date(),
) {
  const seconds = Math.floor(now.getTime() / 1000);
  const bindingHash = createHash("sha256")
    .update(
      JSON.stringify([
        "agent-identification-binding-v1",
        settings.siteId,
        packageSessionBinding(session, mode),
      ]),
    )
    .digest("hex");
  const claims = {
    v: 1,
    purpose: "declaration",
    siteId: settings.siteId,
    origin: settings.origin,
    iat: seconds,
    exp: seconds + 600,
    sessionId: randomUUID(),
    eventId: randomUUID(),
    choice,
    bindingHash,
    evidence: "self_reported",
    ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "AID", v: 1 })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `${header}.${payload}`;
  const receipt = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
  return { receipt, claims };
}
type Declaration = ReturnType<typeof declaration>;
function collector(value: Declaration) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${settings.secret}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return Response.json({
      valid: true,
      sessionId: value.claims.sessionId,
      eventId: value.claims.eventId,
      choice: value.claims.choice,
      evidence: "self_reported",
    });
  };
  return { fetchImplementation, calls };
}
const neverFetch: typeof fetch = async () => {
  assert.fail("An invalid/missing receipt must not reach the collector");
};
const save = (
  session: schema.ResearchSession,
  receipt?: string,
  fetchImplementation: typeof fetch = neverFetch,
  version = 0,
  key = "northstar",
  now = new Date(),
) =>
  research.savePriority(db, session.id, key, "High", version, now, undefined, {
    receipt,
    fetch: fetchImplementation,
  });

before(async () => {
  Object.assign(process.env, env);
  await pg.exec(await readFile("scripts/schema.sql", "utf8"));
});
after(async () => {
  await pg.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("package settings reject missing or noncanonical collector configuration", () => {
  assert.deepEqual(packageSettings(), settings);
  for (const key of Object.keys(env)) {
    const value = process.env[key];
    delete process.env[key];
    assert.throws(packageSettings, /configured/);
    process.env[key] = value;
  }
  for (const url of [
    "https://collector.example/",
    "https://collector.example/path",
    "https://collector.example?secret=x",
    "https://user:password@collector.example",
    "http://collector.example",
  ]) {
    process.env.AGENT_ID_API_URL = url;
    assert.throws(packageSettings);
  }
  process.env.AGENT_ID_API_URL = settings.apiUrl;
});

test("contexts are bound to the server session and persisted mode without changing state", async () => {
  const { session } = await start();
  const before = await state(session);
  const context = await issuePackageContext(db, session, "required");
  assert.equal(context.status, 200);
  assert.ok("bindingContext" in context);
  assert.equal(context.sessionId, session.id);
  assert.equal(context.mode, "required");
  assert.equal(context.siteId, settings.siteId);
  assert.equal(context.apiUrl, settings.apiUrl);
  const claims = JSON.parse(
    Buffer.from(context.bindingContext.split(".")[1], "base64url").toString(),
  );
  assert.equal(claims.purpose, "binding_context");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.equal(claims.exp * 1000, Date.parse(context.expiresAt));
  assert.equal("sessionBinding" in claims, false);
  assert.equal(JSON.stringify(context).includes(settings.secret), false);
  assert.equal(JSON.stringify(context).includes(session.authSessionId), false);
  assert.deepEqual(await state(session), before);
  assert.equal(await packageMode(db, session), "required");
  assert.deepEqual(await issuePackageContext(db, session, "optional"), {
    status: 409,
    code: "package_mode_mismatch",
  });
  const legacy = (await start(null)).session;
  assert.equal(await packageMode(db, legacy), null);
  assert.equal((await issuePackageContext(db, legacy, "required")).status, 409);
});

test("required runs reject a direct save without a receipt regardless of legacy signal or registration", async () => {
  const { session } = await start();
  const result = await research.savePriority(db, session.id, "northstar", "High", 0);
  assert.equal(result.status, 428);
  assert.equal(result.code, "identification_required");
  await research.register(db, session.id, {
    agentName: "Legacy agent",
    actingFor: "R17",
    sources: ["current_website"],
  });
  assert.equal((await save(session)).code, "identification_required");
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
  const results = (await audit(session.id)).filter((event) => event.type === "save_result");
  assert.equal(results.length, 2);
  assert.ok(results.every((event) => event.data.packageMode === "required"));
});

test("optional package policy permits skipping even when the old policy was strict or signalled automation", async () => {
  const { session } = await start("optional", "strict");
  await research.signal(db, session, true);
  const result = await save(session);
  assert.equal(result.status, 200);
  assert.equal(result.code, "saved");
  const stored = await storedSession(session.id);
  assert.equal(stored.acceptedAt, null);
  assert.equal(stored.declaration, null);
  assert.equal(stored.automated, true);
});

test("every explicit package choice can be recorded and satisfy the required save gate", async () => {
  for (const choice of choices) {
    const { session } = await start("required", "strict");
    const value = declaration(session, "required", choice);
    const online = collector(value);
    const before = await state(session);
    const recorded = await recordPackageReceipt(
      db,
      session,
      "required",
      value.receipt,
      new Date(),
      online.fetchImplementation,
    );
    assert.equal(recorded.status, 200, choice);
    assert.ok("choice" in recorded);
    assert.equal(recorded.choice, choice);
    assert.equal(recorded.collectorSessionId, value.claims.sessionId);
    assert.equal(recorded.collectorEventId, value.claims.eventId);
    assert.equal(recorded.evidence, "self_reported");
    assert.deepEqual(await state(session), before);
    assert.equal((await save(session, value.receipt, online.fetchImplementation)).status, 200);
    assert.equal(online.calls.length, 2, "save rechecks current collector state");
    assert.ok(online.calls.every((call) => call.url === `${settings.apiUrl}/v1/verify`));
    assert.ok(
      online.calls.every(
        (call) => call.body.sessionBinding === packageSessionBinding(session, "required"),
      ),
    );
    const stored = await storedSession(session.id);
    assert.equal(stored.declaration, null);
    assert.equal(stored.acceptedAt, null);
    assert.equal(stored.automated, false);
  }
});

test("receipt acknowledgments are idempotent but still verify revocation on every request", async () => {
  const { session } = await start();
  const value = declaration(session);
  const online = collector(value);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (
        await recordPackageReceipt(
          db,
          session,
          "required",
          value.receipt,
          new Date(),
          online.fetchImplementation,
        )
      ).status,
      200,
    );
  }
  assert.equal(online.calls.length, 2);
  assert.equal(
    (await audit(session.id)).filter((event) => event.type === "package_declaration_recorded")
      .length,
    1,
  );
  const revoked: typeof fetch = async () => Response.json({ valid: false }, { status: 410 });
  assert.equal(
    (await recordPackageReceipt(db, session, "required", value.receipt, new Date(), revoked))
      .status,
    503,
  );
  assert.equal((await save(session, value.receipt, revoked)).status, 503);
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
});

test("receipts cannot be replayed across research sessions, runs, login sessions, modes, sites or origins", async () => {
  const { session } = await start();
  const other = (await start()).session;
  const wrong = [
    declaration(other),
    declaration({ ...session, runId: randomUUID() }),
    declaration({ ...session, authSessionId: "different-login" }),
    declaration(session, "optional"),
    declaration(session, "required", "ai_assistant", { siteId: "other-site" }),
    declaration(session, "required", "ai_assistant", { origin: "https://other.example" }),
    declaration(session, "required", "ai_assistant", { bindingHash: null }),
  ];
  for (const value of wrong) {
    assert.equal((await save(session, value.receipt)).code, "identification_invalid");
    assert.equal(
      (await recordPackageReceipt(db, session, "required", value.receipt, new Date(), neverFetch))
        .status,
      428,
    );
  }
  const valid = declaration(session);
  assert.equal(
    (await recordPackageReceipt(db, session, "optional", valid.receipt, new Date(), neverFetch))
      .code,
    "package_mode_mismatch",
  );
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
  assert.equal(
    (await audit(session.id)).filter((event) => event.type === "package_declaration_recorded")
      .length,
    0,
  );
});

test("malformed, tampered, expired and invalid classification receipts fail before online verification", async () => {
  const { session } = await start();
  const value = declaration(session);
  const seconds = Math.floor(Date.now() / 1000);
  const invalid = [
    "",
    "invalid",
    `${value.receipt.slice(0, -1)}!`,
    declaration(session, "required", "ai_assistant", {}, "wrong-secret-000000000000000000000000")
      .receipt,
    declaration(session, "required", "ai_assistant", { iat: seconds - 600, exp: seconds - 1 })
      .receipt,
    declaration(session, "required", "ai_assistant", { choice: "verified-human" }).receipt,
    declaration(session, "required", "ai_assistant", { evidence: "verified" }).receipt,
    declaration(session, "required", "ai_assistant", { eventId: "not-an-event-id" }).receipt,
    declaration(session, "required", "ai_assistant", { extra: "unrecognized" }).receipt,
  ];
  for (const receipt of invalid) {
    assert.equal((await save(session, receipt)).status, 428);
  }
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
});

test("outages and mismatched collector acknowledgments fail closed without claiming acceptance", async () => {
  const { session } = await start();
  const value = declaration(session);
  const failures: (typeof fetch)[] = [
    async () => {
      throw new Error("Network unavailable");
    },
    async () => Response.json({ error: "unavailable" }, { status: 503 }),
    async () => Response.json({ valid: false }, { status: 200 }),
    async () =>
      Response.json({
        valid: true,
        sessionId: randomUUID(),
        eventId: value.claims.eventId,
        choice: value.claims.choice,
        evidence: "self_reported",
      }),
    async () => new Response("not JSON"),
  ];
  for (const failed of failures) {
    assert.equal((await save(session, value.receipt, failed)).code, "identification_unavailable");
    assert.equal(
      (await recordPackageReceipt(db, session, "required", value.receipt, new Date(), failed))
        .status,
      503,
    );
  }
  assert.equal(
    (await audit(session.id)).filter((event) => event.type === "package_declaration_recorded")
      .length,
    0,
  );
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
});

test("a submitted optional receipt is verified and cannot silently become a skipped response", async () => {
  const { session } = await start("optional");
  const value = declaration(session, "optional");
  assert.equal((await save(session, "invalid")).code, "identification_invalid");
  const unavailable: typeof fetch = async () => Response.json({}, { status: 503 });
  assert.equal(
    (await save(session, value.receipt, unavailable)).code,
    "identification_unavailable",
  );
  const online = collector(value);
  assert.equal((await save(session, value.receipt, online.fetchImplementation)).status, 200);
  assert.equal(online.calls.length, 1);
});

test("a valid declaration grants no ticket permissions and does not defeat optimistic version checks", async () => {
  const { session } = await start();
  const value = declaration(session);
  const online = collector(value);
  assert.equal((await save(session, value.receipt, neverFetch, 0, "meridian")).status, 403);
  assert.equal((await save(session, value.receipt, neverFetch, 0, "missing")).status, 404);
  assert.equal((await save(session, value.receipt, online.fetchImplementation)).status, 200);
  assert.equal(
    (await save(session, value.receipt, online.fetchImplementation)).code,
    "version_conflict",
  );
  const ticket = (await research.listTickets(db, session)).find((item) => item.key === "northstar");
  assert.equal(ticket?.version, 1);
  assert.equal(ticket?.priority, "High");
});

test("package receipts do not replace legacy registration on historical runs", async () => {
  const { session } = await start(null, "strict");
  const value = declaration(session);
  assert.equal((await save(session, value.receipt)).code, "registration_required");
  assert.equal(
    (await recordPackageReceipt(db, session, "required", value.receipt, new Date(), neverFetch))
      .code,
    "package_mode_mismatch",
  );
  await research.register(db, session.id, {
    agentName: "Legacy agent",
    actingFor: "R17",
    sources: ["current_website"],
  });
  assert.equal((await save(session)).status, 200);
});

test("closed, expired, idle or changed-login contexts cannot acknowledge declarations", async () => {
  for (const scenario of ["closed", "expired", "idle", "login", "missing"] as const) {
    const { session } = await start();
    const value = declaration(session);
    let now = new Date();
    if (scenario === "closed") await research.closeSession(db, session);
    if (scenario === "expired") now = new Date(session.expiresAt.getTime() + 1);
    if (scenario === "idle") now = new Date(session.lastSeenAt.getTime() + 30 * 60 * 1000);
    if (scenario === "login") {
      await db
        .update(schema.sessions)
        .set({ authSessionId: "new-login" })
        .where(eq(schema.sessions.id, session.id));
    }
    if (scenario === "missing")
      await db.delete(schema.runs).where(eq(schema.runs.id, session.runId));
    const before = await audit(session.id);
    assert.equal((await issuePackageContext(db, session, "required", now)).status, 401, scenario);
    assert.equal(
      (await recordPackageReceipt(db, session, "required", value.receipt, now, neverFetch)).status,
      401,
      scenario,
    );
    assert.deepEqual(await audit(session.id), before);
  }
});

test("new runs invalidate previous receipts, and closed sessions cannot save", async () => {
  const first = (await start()).session;
  const receipt = declaration(first).receipt;
  await research.closeSession(db, first, "new_run");
  assert.equal((await save(first, receipt)).code, "session_expired");
  const second = (await start()).session;
  assert.equal((await save(second, receipt)).code, "identification_invalid");
  assert.notEqual(
    packageSessionBinding(first, "required"),
    packageSessionBinding(second, "required"),
  );
});

test("verification time cannot extend an expired declaration or research session", async () => {
  const now = new Date();
  const { session } = await start();
  const earlier = new Date(now.getTime() - 1000);
  const value = declaration(
    session,
    "required",
    "ai_assistant",
    { exp: Math.floor(now.getTime() / 1000) },
    settings.secret,
    earlier,
  );
  const online = collector(value);
  assert.equal(
    (await save(session, value.receipt, online.fetchImplementation, 0, "northstar", earlier))
      .status,
    401,
  );
  assert.equal(
    (
      await recordPackageReceipt(
        db,
        session,
        "required",
        value.receipt,
        earlier,
        online.fetchImplementation,
      )
    ).status,
    401,
  );
  assert.equal((await research.listTickets(db, session))[0].priority, "Medium");
});

test("context and receipt secrets never enter audit records or projected evidence", async () => {
  const { session } = await start();
  const context = await issuePackageContext(db, session, "required");
  assert.ok("bindingContext" in context && context.bindingContext);
  const bindingContext = context.bindingContext;
  const value = declaration(session);
  const online = collector(value);
  await recordPackageReceipt(
    db,
    session,
    "required",
    value.receipt,
    new Date(),
    online.fetchImplementation,
  );
  await save(session, value.receipt, online.fetchImplementation);
  const report = await research.summary(db, session.id);
  assert.ok(report);
  const raw = JSON.stringify(report);
  for (const secret of [value.receipt, bindingContext, settings.secret, session.tokenHash]) {
    assert.equal(raw.includes(secret), false);
  }
  const snapshot = snapshotSummarySchema.parse({
    ...report,
    events: report.events.map((event) => ({
      ...event,
      data: {
        ...event.data,
        receipt: value.receipt,
        bindingContext,
        secret: settings.secret,
        authorization: "private-auth-header",
        cookies: "private-cookie",
      },
    })),
  });
  const exported = JSON.stringify(snapshot);
  for (const secret of [value.receipt, bindingContext, settings.secret, "private-"]) {
    assert.equal(exported.includes(secret), false);
  }
  const recorded = snapshot.events.find((event) => event.type === "package_declaration_recorded");
  assert.deepEqual(recorded?.data, {
    mode: "required",
    choice: "ai_assistant",
    collectorSessionId: value.claims.sessionId,
    collectorEventId: value.claims.eventId,
    evidence: "self_reported",
    sdkVersion: "0.1.0",
  });
  const started = snapshot.events.find((event) => event.type === "session_started");
  assert.ok(started && "packageMode" in started.data);
  assert.equal(started.data.packageMode, "required");
  const result = snapshot.events.find((event) => event.type === "save_result");
  assert.ok(
    result &&
      "collectorEventId" in result.data &&
      "collectorSessionId" in result.data &&
      "choice" in result.data &&
      "packageMode" in result.data,
  );
  assert.equal(result.data.collectorEventId, value.claims.eventId);
  assert.equal(result.data.collectorSessionId, value.claims.sessionId);
  assert.equal(result.data.choice, "ai_assistant");
  assert.equal(result.data.packageMode, "required");
});

test("snapshot evidence rejects malformed package declarations instead of dropping their fields", async () => {
  const { session } = await start();
  const value = declaration(session);
  const online = collector(value);
  await recordPackageReceipt(
    db,
    session,
    "required",
    value.receipt,
    new Date(),
    online.fetchImplementation,
  );
  const report = await research.summary(db, session.id);
  assert.ok(report);
  for (const invalid of [
    { mode: "strict" },
    { choice: "verified-human" },
    { collectorSessionId: "invalid-id" },
    { collectorEventId: "invalid-id" },
    { evidence: "verified" },
    { sdkVersion: "arbitrary-private-value" },
  ]) {
    const changed: unknown = {
      ...report,
      events: report.events.map((event) =>
        event.type === "package_declaration_recorded"
          ? { ...event, data: { ...event.data, ...invalid } }
          : event,
      ),
    };
    assert.equal(snapshotSummarySchema.safeParse(changed).success, false);
  }
});

test("package verifier reports missing receipt without contacting the collector", async () => {
  const { session } = await start();
  assert.deepEqual(
    await checkPackageReceipt(session, "required", undefined, new Date(), neverFetch),
    {
      status: 428,
      code: "identification_required",
    },
  );
});

test("operator summaries and snapshots distinguish package mode from the legacy gate", async () => {
  for (const mode of ["optional", "required", null] as const) {
    const { session } = await start(mode, "strict");
    const report = await research.summary(db, session.id);
    assert.ok(report);
    assert.equal(report.configuration.mode, "strict");
    assert.equal(report.configuration.packageMode, mode);
    assert.equal(report.configuration.policyVersion, mode ? "package-v1" : "pilot-v1");
    assert.equal(report.ruleId, mode ? "package-v1.evidence-first" : "pilot-v1.evidence-first");
    const snapshot = snapshotSummarySchema.parse(report);
    assert.equal(snapshot.configuration.mode, "strict");
    assert.equal(snapshot.configuration.packageMode, mode);
  }
});

test("historical snapshots without package mode still parse and unknown modes are rejected", async () => {
  const { session } = await start(null);
  const report = await research.summary(db, session.id);
  assert.ok(report);
  const historical = {
    ...report,
    configuration: {
      mode: report.configuration.mode,
      taskKey: report.configuration.taskKey,
      policyVersion: report.configuration.policyVersion,
    },
  };
  const snapshot = snapshotSummarySchema.parse(historical);
  assert.equal(snapshot.configuration.packageMode, undefined);
  assert.equal(
    snapshotSummarySchema.safeParse({
      ...historical,
      configuration: { ...historical.configuration, packageMode: "strict" },
    }).success,
    false,
  );
});

test("legacy evidence ratings cannot be applied to package runs even with fully matched observations", () => {
  const sessionId = randomUUID(),
    runId = randomUUID(),
    attemptId = randomUUID();
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, seconds)).toISOString();
  const event = (
    sequence: number,
    type: string,
    seconds: number,
    data: Record<string, unknown>,
  ) => ({
    id: type === "save_attempt" ? attemptId : randomUUID(),
    sessionId,
    runId,
    sequence,
    origin: "server" as const,
    type,
    data,
    createdAt: at(seconds),
  });
  const summary: EvidenceSummary = {
    session: { id: sessionId, runId, expiresAt: at(7200), closedAt: at(10) },
    configuration: { taskKey: "northstar", policyVersion: "pilot-v1", packageMode: null },
    taskOutcome: "Complete",
    events: [
      event(1, "session_started", 0, {}),
      event(2, "save_attempt", 2, { ticketKey: "northstar", priority: "High" }),
      event(3, "save_result", 2, {
        ticketKey: "northstar",
        priority: "High",
        attemptId,
        status: 200,
        code: "saved",
      }),
      event(4, "session_closed", 10, {}),
    ],
  };
  const observed = (id: string) => ({
    id,
    sessionId,
    runId,
    startedAt: at(1),
    endedAt: at(3),
    actorId: "agent-1",
    sourceCallRef: `call-${id}`,
    ticketKey: "northstar" as const,
    priority: "High" as const,
  });
  // Synthetic complete observer fixture; this is not an actual agent trial.
  const trace: IndependentTrace = {
    schemaVersion: "pilot-evidence-v1",
    sessionId,
    runId,
    artifact: { sha256: "a".repeat(64), sourceRef: "test/tool-trace", kind: "runtime_tool_trace" },
    review: {
      reviewRef: "test-review",
      reviewerId: "test-operator",
      reviewedAt: at(20),
      artifactSha256: "a".repeat(64),
      basis: "original_tool_trace",
      scope: "complete_session",
      reviewedCallRefs: ["call-start", "call-close", "call-attempt", "call-result"],
      unresolvedGaps: [],
    },
    window: { startedAt: at(-1), closedAt: at(11), closureCallRef: "call-close" },
    actors: [{ id: "agent-1", kind: "agent" }],
    attribution: [
      { startedAt: at(-1), endedAt: at(11), actorId: "agent-1", sourceCallRef: "call-start" },
    ],
    handoffs: [],
    events: [
      { ...observed("attempt"), type: "save_attempt" },
      {
        ...observed("result"),
        type: "save_result",
        status: 200,
        code: "saved",
        attemptRef: "attempt",
      },
    ],
    registrations: [],
    integrityObservations: [],
  };
  const baseline = evaluateEvidence(summary, trace);
  assert.equal(baseline.activityRating, "Routine");
  assert.deepEqual(baseline.evidenceGaps, []);
  const packageGap =
    "Package identification evidence is not supported by pilot-evidence-v1; package declaration authorship and policy checks are not implemented.";
  for (const mode of ["optional", "required"] as const) {
    const packageSummary = {
      ...summary,
      configuration: { ...summary.configuration, policyVersion: "package-v1", packageMode: mode },
    };
    const result = evaluateEvidence(packageSummary, trace);
    assert.equal(result.activityRating, "Insufficient evidence");
    assert.equal(result.taskOutcome, "Complete");
    assert.equal(result.coverage.ratio, 1);
    assert.deepEqual(result.evidenceGaps, [packageGap]);
    assert.ok(evaluateEvidence(packageSummary, null).evidenceGaps.includes(packageGap));
    const mislabeled = {
      ...packageSummary,
      configuration: { ...packageSummary.configuration, policyVersion: "pilot-v1" },
    };
    assert.equal(evaluateEvidence(mislabeled, trace).activityRating, "Insufficient evidence");
  }
});
