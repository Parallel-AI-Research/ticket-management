import { z } from "zod";
import { declarationSchema, priorities, ticketKeys } from "../../src/lib/domain";
import { summarySchema } from "../../src/lib/research/evidence";

const timestamp = z.iso.datetime({ offset: true });
const classification = z.enum(["useful", "unknown", "withheld", "not_applicable"]);
const completeness = z.object({
  fields: z.object({
    agentName: classification,
    actingFor: classification,
    sources: classification,
  }),
  usefulFieldTotal: z.number().int().min(0).max(3),
});
const shortText = z.string().max(250);

// Export an explicit projection. Future server fields (e.g. auth metadata) must not
// silently enter a retained local artifact. Raw bodies and credentials are excluded.
const eventData = z.object({
  type: shortText.optional(),
  pseudonym: shortText.optional(),
  taskKey: z.enum(ticketKeys).optional(),
  mode: z.enum(["selective", "strict"]).optional(),
  webdriver: z.boolean().optional(),
  evidence: shortText.optional(),
  expiresAt: timestamp.optional(),
  reason: shortText.optional(),
  declaration: declarationSchema.optional(),
  completeness: completeness.optional(),
  submissionPath: z.enum(["same_origin", "nonce_exchange"]).optional(),
  authorship: z.literal("unverified").optional(),
  ticketKey: shortText.optional(),
  priority: z.enum(priorities).nullable().optional(),
  trigger: z.boolean().optional(),
  signalReceived: z.boolean().optional(),
  registrationAccepted: z.boolean().optional(),
  attemptId: z.uuid().optional(),
  code: shortText.optional(),
  status: z.number().int().min(100).max(599).optional(),
  outOfScope: z.boolean().optional(),
  path: shortText.optional(),
  outcome: z.enum(["success", "blocked", "error"]).optional(),
});

export const snapshotSummarySchema = summarySchema.extend({
  session: summarySchema.shape.session.extend({
    pseudonym: shortText,
    automatedSignal: z.boolean(),
  }),
  configuration: summarySchema.shape.configuration.extend({
    mode: z.enum(["selective", "strict"]),
  }),
  declaration: declarationSchema.nullable(),
  completeness: completeness.nullable(),
  operations: z.object({ attempted: z.number(), successful: z.number(), blocked: z.number() }),
  finalTickets: z
    .array(
      z.object({
        key: z.enum(ticketKeys),
        priority: z.enum(priorities),
        version: z.number().int().nonnegative(),
        updatedAt: timestamp,
        canEdit: z.boolean(),
      }),
    )
    .length(4),
  events: z.array(summarySchema.shape.events.element.extend({ data: eventData })),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal("operator-snapshot-v1"),
  capturedAt: timestamp,
  origin: z.string(),
  summary: snapshotSummarySchema,
});
