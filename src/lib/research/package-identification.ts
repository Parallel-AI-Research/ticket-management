import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  createBindingContext,
  verifyDeclaration,
  verifyDeclarationOnline,
} from "@parallel-research/agent-identification/server";
import type { Database } from "../db";
import { events, sessions, type ResearchSession } from "../db/schema";

export type PackageMode = "optional" | "required";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Store = Database | Tx;
export const isPackageMode = (value: unknown): value is PackageMode =>
  value === "optional" || value === "required";

const live = (s: ResearchSession, now: Date) =>
  !s.closedAt && s.expiresAt > now && now.getTime() - s.lastSeenAt.getTime() < 30 * 60 * 1000;

/** The run's server-written start event is immutable through the application API. */
export async function packageMode(
  db: Store,
  session: ResearchSession,
): Promise<PackageMode | null> {
  const [start] = await db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.sessionId, session.id),
        eq(events.origin, "server"),
        eq(events.type, "session_started"),
      ),
    );
  if (!start) throw new Error("Research session start record missing");
  const mode = start.data.packageMode;
  if (mode == null) return null;
  if (!isPackageMode(mode)) throw new Error("Invalid package mode");
  return mode;
}

export function packageSettings() {
  const siteId = process.env.AGENT_ID_SITE_ID;
  const secret = process.env.AGENT_ID_SITE_SECRET;
  const apiUrl = process.env.AGENT_ID_API_URL;
  const origin = process.env.APP_ORIGIN;
  if (!siteId || !secret || !apiUrl || !origin) throw new Error("Package not configured");
  const api = new URL(apiUrl);
  if (
    api.origin !== apiUrl ||
    (api.protocol !== "https:" &&
      !(
        process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1"].includes(api.hostname)
      ))
  )
    throw new Error("Invalid collector origin");
  // Validate signed-context configuration before exposing any public settings.
  createBindingContext({ siteId, secret, origin, sessionBinding: "configuration-check" });
  return { siteId, secret, apiUrl, origin };
}

export function packageSessionBinding(session: ResearchSession, mode: PackageMode) {
  return createHash("sha256")
    .update(
      JSON.stringify(["ticket-package-v1", session.id, session.runId, session.authSessionId, mode]),
    )
    .digest("hex");
}

function sameSession(current: ResearchSession, expected: ResearchSession, now: Date) {
  return (
    current.id === expected.id &&
    current.principalId === expected.principalId &&
    current.authSessionId === expected.authSessionId &&
    current.runId === expected.runId &&
    live(current, now)
  );
}

export async function issuePackageContext(
  db: Database,
  session: ResearchSession,
  mode: PackageMode,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .for("share");
    if (!current || !sameSession(current, session, now))
      return { status: 401, code: "session_expired" } as const;
    if ((await packageMode(tx, current)) !== mode)
      return { status: 409, code: "package_mode_mismatch" } as const;
    const settings = packageSettings();
    const expiresInSeconds = Math.min(
      600,
      Math.floor((current.expiresAt.getTime() - now.getTime()) / 1000),
    );
    if (expiresInSeconds < 1) return { status: 401, code: "session_expired" } as const;
    const bindingContext = createBindingContext({
      ...settings,
      sessionBinding: packageSessionBinding(current, mode),
      now,
      expiresInSeconds,
    });
    return {
      status: 200,
      code: "package_context_issued",
      sessionId: current.id,
      mode,
      siteId: settings.siteId,
      apiUrl: settings.apiUrl,
      bindingContext,
      expiresAt: new Date(
        (Math.floor(now.getTime() / 1000) + expiresInSeconds) * 1000,
      ).toISOString(),
    } as const;
  });
}

/** Both invalid receipts and collector outages fail closed; errors never include the receipt. */
export async function checkPackageReceipt(
  session: ResearchSession,
  mode: PackageMode,
  receipt: string | undefined,
  now = new Date(),
  fetchImplementation?: typeof fetch,
) {
  if (!receipt) return { status: 428, code: "identification_required" } as const;
  const settings = {
    ...packageSettings(),
    sessionBinding: packageSessionBinding(session, mode),
    now,
  };
  try {
    verifyDeclaration(receipt, settings);
  } catch {
    return { status: 428, code: "identification_invalid" } as const;
  }
  try {
    const claims = await verifyDeclarationOnline(receipt, {
      ...settings,
      fetch: fetchImplementation,
    });
    return { status: 200, code: "package_receipt_verified", claims } as const;
  } catch {
    return { status: 503, code: "identification_unavailable" } as const;
  }
}

export async function recordPackageReceipt(
  db: Database,
  session: ResearchSession,
  mode: PackageMode,
  receipt: string,
  now = new Date(),
  fetchImplementation?: typeof fetch,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .for("update");
    if (!current || !sameSession(current, session, now))
      return { status: 401, code: "session_expired" } as const;
    if ((await packageMode(tx, current)) !== mode)
      return { status: 409, code: "package_mode_mismatch" } as const;
    const result = await checkPackageReceipt(current, mode, receipt, now, fetchImplementation);
    if (result.status !== 200) return result;
    const { claims } = result;
    // Also account for time spent waiting for the external collector.
    const checkedAt = new Date(Math.max(now.getTime(), Date.now()));
    if (!live(current, checkedAt) || claims.exp * 1000 <= checkedAt.getTime())
      return { status: 401, code: "session_expired" } as const;
    const prior = await tx
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.sessionId, current.id),
          eq(events.type, "package_declaration_recorded"),
          eq(events.origin, "server"),
        ),
      );
    if (!prior.some((event) => event.data.collectorEventId === claims.eventId)) {
      await tx.insert(events).values({
        id: randomUUID(),
        sessionId: current.id,
        runId: current.runId,
        origin: "server",
        type: "package_declaration_recorded",
        data: {
          mode,
          choice: claims.choice,
          collectorSessionId: claims.sessionId,
          collectorEventId: claims.eventId,
          evidence: "self_reported",
          sdkVersion: "0.1.0",
        },
      });
    }
    return {
      status: 200,
      code: "package_receipt_verified",
      sessionId: current.id,
      mode,
      choice: claims.choice,
      collectorSessionId: claims.sessionId,
      collectorEventId: claims.eventId,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      evidence: "self_reported",
    } as const;
  });
}
