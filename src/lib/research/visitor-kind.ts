import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db";
import { events, sessions, type ResearchSession } from "../db/schema";

export const visitorKindVariantSchema = z.enum(["v5", "v6"]);
export const visitorKindChoiceSchema = z.enum(["ai_assistant", "person", "prefer_not_to_say"]);
export const visitorKindSchema = z
  .object({
    sessionId: z.uuid(),
    variant: visitorKindVariantSchema,
    choice: visitorKindChoiceSchema,
  })
  .strict();
export type VisitorKindChoice = z.infer<typeof visitorKindChoiceSchema>;
export type VisitorKindVariant = z.infer<typeof visitorKindVariantSchema>;

const storedChoiceSchema = z.object({
  variant: visitorKindVariantSchema,
  choice: visitorKindChoiceSchema,
  evidence: z.literal("self_reported"),
});
const IDLE_MS = 30 * 60 * 1000;
const liveBoundSession = (
  current: ResearchSession | undefined,
  bound: ResearchSession,
  now: Date,
) =>
  !!current &&
  current.principalId === bound.principalId &&
  current.authSessionId === bound.authSessionId &&
  current.runId === bound.runId &&
  !current.closedAt &&
  current.expiresAt > now &&
  now.getTime() - current.lastSeenAt.getTime() < IDLE_MS;

/** An explicit session classification only; never registration or an automation signal. */
export async function declareVisitorKind(
  db: Database,
  session: ResearchSession,
  input: unknown,
  now = new Date(),
) {
  const parsed = visitorKindSchema.safeParse(input);
  if (!parsed.success) return { status: 422, code: "invalid_visitor_kind" } as const;
  if (parsed.data.sessionId !== session.id)
    return { status: 403, code: "session_mismatch" } as const;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .for("update");
    if (!liveBoundSession(current, session, now))
      return { status: 401, code: "session_expired" } as const;

    const eventId = randomUUID();
    const { variant, choice } = parsed.data;
    await tx.insert(events).values({
      id: eventId,
      sessionId: current.id,
      runId: current.runId,
      origin: "server",
      type: "visitor_kind_declared",
      data: { variant, choice, evidence: "self_reported" },
    });
    return {
      status: 200,
      code: "visitor_kind_accepted",
      accepted: true,
      sessionId: current.id,
      eventId,
      variant,
      choice,
    } as const;
  });
}

/** Read the latest explicit choice for this session and variant without extending its lifetime. */
export async function visitorKindStatus(
  db: Database,
  session: ResearchSession,
  variant: unknown,
  now = new Date(),
) {
  const parsedVariant = visitorKindVariantSchema.safeParse(variant);
  if (!parsedVariant.success) return { status: 422, code: "invalid_visitor_kind_variant" } as const;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .for("share");
    if (!liveBoundSession(current, session, now))
      return { status: 401, code: "session_expired" } as const;

    const [latest] = await tx
      .select({ id: events.id, data: events.data })
      .from(events)
      .where(
        and(
          eq(events.sessionId, current.id),
          eq(events.runId, current.runId),
          eq(events.origin, "server"),
          eq(events.type, "visitor_kind_declared"),
          sql`${events.data}->>'variant' = ${parsedVariant.data}`,
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(1);
    const parsedChoice = storedChoiceSchema.safeParse(latest?.data);
    return {
      status: 200,
      code: "visitor_kind_status_read",
      accepted: parsedChoice.success,
      sessionId: current.id,
      variant: parsedVariant.data,
      choice: parsedChoice.success ? parsedChoice.data.choice : null,
      eventId: parsedChoice.success ? latest.id : null,
    } as const;
  });
}
