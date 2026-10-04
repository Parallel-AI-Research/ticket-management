import {
  pgSchema,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
  bigserial,
} from "drizzle-orm/pg-core";
import type { Declaration, GateMode } from "../domain";
export const research = pgSchema("research");
export const runs = research.table("runs", {
  id: uuid().primaryKey(),
  ownerId: text("owner_id").notNull(),
  taskKey: text("task_key").notNull(),
  mode: text().$type<GateMode>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
export const sessions = research.table("sessions", {
  id: uuid().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  principalId: text("principal_id").notNull(),
  authSessionId: text("auth_session_id").notNull(),
  pseudonym: text().notNull().default("R17"),
  automated: boolean().notNull().default(false),
  signalReceived: boolean("signal_received").notNull().default(false),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedUntil: timestamp("accepted_until", { withTimezone: true }),
  declaration: jsonb().$type<Declaration>(),
  declaredPseudonym: text("declared_pseudonym"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
export const tickets = research.table(
  "tickets",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    key: text().notNull(),
    priority: text().notNull(),
    version: integer().notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.key] })],
);
export const events = research.table(
  "events",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    id: uuid().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    origin: text().notNull(),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_session_idx").on(t.sessionId, t.createdAt)],
);
export const nonces = research.table("nonces", {
  hash: text().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  principalId: text("principal_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
export type ResearchSession = typeof sessions.$inferSelect;
