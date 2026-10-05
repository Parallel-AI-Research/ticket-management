import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { configured, supabaseServer } from "@/lib/supabase/server";
import { getDb, isFixtureMode } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eventSchema, registrationSchema, saveSchema } from "@/lib/domain";
import { agentPolicy } from "@/lib/research/policy";
import * as research from "@/lib/research/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "parallel_research_session";
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
async function body(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "json_required");
  const content = await request.text();
  if (Buffer.byteLength(content) > 16384) throw new HttpError(413, "request_too_large");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin &&
      origin !== allowed &&
      !(
        process.env.NODE_ENV === "development" &&
        ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)
      ))
  )
    throw new HttpError(403, "origin_not_allowed");
}
async function identity() {
  if (isFixtureMode())
    return { id: "fixture-participant", authSessionId: "fixture-login", fixture: true };
  if (!configured()) throw new HttpError(503, "supabase_not_configured");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims.sub || !data.claims.session_id)
    throw new HttpError(401, "sign_in_required");
  await assertAuthSession(data.claims.sub, String(data.claims.session_id));
  return { id: data.claims.sub, authSessionId: String(data.claims.session_id), fixture: false };
}
async function assertAuthSession(principalId: string, authSessionId: string) {
  if (isFixtureMode()) return;
  const db = await getDb();
  const rows = await db.execute(
    sql`select id from research.auth_session_lookup where id = ${authSessionId}::uuid and user_id = ${principalId}::uuid limit 1`,
  );
  if (!rows.length) throw new HttpError(401, "sign_in_required");
}
async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7200,
  });
}
async function context(create = false, auditExpired = false, touch = true) {
  const user = await identity(),
    db = await getDb(),
    token = (await cookies()).get(COOKIE)?.value;
  let session = token
    ? await research.resolveSession(db, token, user.id, user.authSessionId, new Date(), touch)
    : null;
  if (!session && token && auditExpired) {
    const [old] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, research.hashToken(token)),
          eq(sessions.principalId, user.id),
          eq(sessions.authSessionId, user.authSessionId),
        ),
      );
    session = old ?? null;
  }
  if (!session && create) {
    const created = await research.startRun(
      db,
      user.id,
      user.authSessionId,
      "northstar",
      process.env.GATE_MODE === "strict" ? "strict" : "selective",
    );
    await setSessionCookie(created.token);
    session = created.session;
  }
  if (!session) throw new HttpError(401, "session_required");
  return { user, db, session };
}
async function operator(request: Request) {
  const token = process.env.OPERATOR_TOKEN,
    supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (
    token &&
    token.length >= 32 &&
    supplied &&
    Buffer.byteLength(token) === Buffer.byteLength(supplied) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(supplied))
  )
    return;
  const user = await identity();
  if (
    !(process.env.OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(user.id)
  )
    throw new HttpError(403, "operator_access_required");
}
type Params = { params: Promise<{ path: string[] }> };
async function handler(request: NextRequest, params: Params) {
  try {
    const path = (await params.params).path.join("/"),
      method = request.method;
    if (method === "GET" && path === "health")
      return json({ ok: true, configured: configured(), fixtureMode: isFixtureMode() });
    if (method === "GET" && path === "agent-policy") return json(agentPolicy);
    if (method === "POST" && path === "auth/login") {
      sameOrigin(request);
      if (!configured()) throw new HttpError(503, "supabase_not_configured");
      const parsed = z
        .object({ email: z.email(), password: z.string().min(1).max(200) })
        .strict()
        .safeParse(await body(request));
      if (!parsed.success) throw new HttpError(422, "invalid_credentials");
      const supabase = await supabaseServer();
      // Close the prior research session before a login exchange, even for the same account.
      try {
        const c = await context();
        await research.closeSession(c.db, c.session, "login_exchange");
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
      (await cookies()).delete(COOKIE);
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) throw new HttpError(401, "invalid_credentials");
      return json({ ok: true });
    }
    if (method === "POST" && path === "auth/logout") {
      sameOrigin(request);
      try {
        const c = await context();
        await research.closeSession(c.db, c.session);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
      if (!isFixtureMode() && configured()) {
        const { error } = await (await supabaseServer()).auth.signOut();
        if (error) throw new HttpError(503, "logout_failed");
      }
      (await cookies()).delete(COOKIE);
      return json({ ok: true });
    }
    if (method === "GET" && path === "session") {
      const c = await context(true);
      return json({
        pseudonym: c.session.pseudonym,
        runId: c.session.runId,
        sessionId: c.session.id,
        fixtureMode: c.user.fixture,
      });
    }
    if (method === "GET" && path === "tickets") {
      const c = await context(true);
      const all = await research.listTickets(c.db, c.session);
      const q = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? "";
      const priority = request.nextUrl.searchParams.get("priority");
      return json({
        tickets: all.filter(
          (t) =>
            `${t.title} ${t.code} ${t.description}`.toLowerCase().includes(q) &&
            (!priority || t.priority === priority),
        ),
      });
    }
    if (method === "GET" && /^tickets\/[^/]+$/.test(path)) {
      const c = await context(true);
      const ticket = (await research.listTickets(c.db, c.session)).find(
        (t) => t.key === path.split("/")[1],
      );
      if (!ticket) throw new HttpError(404, "ticket_not_found");
      return json({ ticket });
    }
    if (method === "PATCH" && /^tickets\/[^/]+\/priority$/.test(path)) {
      sameOrigin(request);
      const c = await context(false, true);
      let payload: unknown;
      try {
        payload = await body(request);
      } catch (e) {
        const reason =
          e instanceof HttpError
            ? { status: e.status, code: e.code }
            : { status: 400, code: "invalid_body" };
        await research.savePriority(
          c.db,
          c.session.id,
          path.split("/")[1],
          null,
          null,
          new Date(),
          reason,
        );
        throw e;
      }
      const parsed = saveSchema.safeParse(payload);
      const result = await research.savePriority(
        c.db,
        c.session.id,
        path.split("/")[1],
        parsed.success ? parsed.data.priority : null,
        parsed.success ? parsed.data.version : null,
      );
      return json(result, result.status);
    }
    if (method === "POST" && path === "runs") {
      sameOrigin(request);
      const c = await context(true);
      const parsed = z
        .object({ taskKey: z.enum(["northstar", "atlas", "beacon"]).default("northstar") })
        .strict()
        .safeParse(await body(request));
      if (!parsed.success) throw new HttpError(422, "invalid_task");
      await research.closeSession(c.db, c.session, "new_run");
      const created = await research.startRun(
        c.db,
        c.user.id,
        c.user.authSessionId,
        parsed.data.taskKey,
        process.env.GATE_MODE === "strict" ? "strict" : "selective",
      );
      await setSessionCookie(created.token);
      return json({ runId: created.session.runId, sessionId: created.session.id }, 201);
    }
    if (method === "POST" && path === "signals") {
      sameOrigin(request);
      const c = await context(true);
      const parsed = z
        .object({ webdriver: z.boolean() })
        .strict()
        .safeParse(await body(request));
      if (!parsed.success) throw new HttpError(422, "invalid_signal");
      await research.signal(c.db, c.session, parsed.data.webdriver);
      return json({ ok: true });
    }
    if (method === "GET" && path === "agent-registration/status") {
      const c = await context(false, false, false);
      return json(await research.registrationStatus(c.db, c.session));
    }
    if (method === "POST" && path === "agent-registration/challenge") {
      sameOrigin(request);
      const c = await context();
      return json(await research.issueNonce(c.db, c.session));
    }
    if (method === "POST" && path === "agent-registration") {
      let payload: unknown;
      try {
        payload = await body(request);
      } catch (e) {
        sameOrigin(request);
        const c = await context();
        await research.register(c.db, c.session.id, null);
        throw e;
      }
      const parsed = registrationSchema.safeParse(payload);
      if (!parsed.success) {
        sameOrigin(request);
        const c = await context();
        await research.register(c.db, c.session.id, null);
        throw new HttpError(422, "invalid_declaration");
      }
      const { nonce, sessionId, ...declaration } = parsed.data;
      if (nonce) {
        if (!sessionId) throw new HttpError(422, "session_id_required");
        const db = await getDb();
        const [bound] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
        if (!bound) throw new HttpError(401, "session_required");
        try {
          await assertAuthSession(bound.principalId, bound.authSessionId);
        } catch (e) {
          if (e instanceof HttpError)
            await research.closeSession(db, bound, "auth_session_revoked");
          throw e;
        }
        const result = await research.register(await getDb(), sessionId, declaration, nonce);
        return json(result, result.status);
      }
      sameOrigin(request);
      const c = await context();
      if (sessionId && sessionId !== c.session.id) throw new HttpError(403, "session_mismatch");
      const result = await research.register(c.db, c.session.id, declaration);
      return json(result, result.status);
    }
    if (method === "POST" && path === "events") {
      sameOrigin(request);
      const c = await context();
      const parsed = eventSchema.safeParse(await body(request));
      if (!parsed.success) throw new HttpError(422, "invalid_event");
      if (!(await research.track(c.db, c.session, parsed.data)))
        throw new HttpError(409, "tracking_not_started");
      return json({ ok: true });
    }
    if (method === "GET" && /^operator\/sessions\/[^/]+$/.test(path)) {
      await operator(request);
      const id = z.uuid().safeParse(path.split("/")[2]);
      if (!id.success) throw new HttpError(400, "invalid_session_id");
      const result = await research.summary(await getDb(), id.data);
      if (!result) throw new HttpError(404, "session_not_found");
      return json(result);
    }
    throw new HttpError(404, "not_found");
  } catch (error) {
    if (error instanceof HttpError) return json({ code: error.code }, error.status);
    // Never return connection strings, raw SQL, auth tokens, or declarations in errors.
    console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
    return json({ code: "service_unavailable" }, 503);
  }
}
export { handler as GET, handler as POST, handler as PATCH };
