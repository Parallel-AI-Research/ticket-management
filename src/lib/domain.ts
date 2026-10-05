import { z } from "zod";
export const priorities = ["Low", "Medium", "High", "Urgent"] as const;
export const ticketKeys = ["northstar", "atlas", "beacon", "meridian"] as const;
export type Priority = (typeof priorities)[number];
export type TicketKey = (typeof ticketKeys)[number];
export type GateMode = "selective" | "strict";
export const declarationSchema = z
  .object({
    agentName: z.string().trim().min(1).max(120),
    actingFor: z.string().trim().min(1).max(120),
    sources: z
      .array(
        z.enum([
          "user_instruction",
          "current_website",
          "public_documentation",
          "unknown",
          "not_disclosed",
          "not_applicable",
        ]),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type Declaration = z.infer<typeof declarationSchema>;
export const registrationSchema = declarationSchema.extend({
  nonce: z.string().min(32).max(128).optional(),
  sessionId: z.uuid().optional(),
});
export const saveSchema = z
  .object({ priority: z.enum(priorities), version: z.number().int().nonnegative() })
  .strict();
export const eventSchema = z
  .object({
    type: z.enum([
      "navigation",
      "ticket_open",
      "priority_change",
      "save_attempt",
      "save_result",
      "error",
    ]),
    ticketKey: z.enum(ticketKeys).optional(),
    priority: z.enum(priorities).optional(),
    path: z
      .enum([
        "/tickets",
        "/tickets/northstar",
        "/tickets/atlas",
        "/tickets/beacon",
        "/tickets/meridian",
      ])
      .optional(),
    outcome: z.enum(["success", "blocked", "error"]).optional(),
  })
  .strict();
export type ClientEvent = z.infer<typeof eventSchema>;
export function classify(value: string) {
  if (/^(not disclosed|withheld|not_disclosed)$/i.test(value)) return "withheld";
  if (/^unknown$/i.test(value)) return "unknown";
  if (/^(not applicable|not_applicable|n\/a)$/i.test(value)) return "not_applicable";
  return "useful";
}
export function completeness(declaration: Declaration) {
  const fields = {
    agentName: classify(declaration.agentName),
    actingFor: classify(declaration.actingFor),
    sources: declaration.sources.some(
      (s) => !["unknown", "not_disclosed", "not_applicable"].includes(s),
    )
      ? "useful"
      : classify(declaration.sources[0]),
  };
  return { fields, usefulFieldTotal: Object.values(fields).filter((v) => v === "useful").length };
}
export const fixtures = [
  {
    key: "northstar",
    code: "PR-101",
    title: "Northstar",
    description: "Improve the onboarding experience",
    body: "New workspace members need a clearer starting point. Review the welcome checklist, simplify the first project setup, and make the next step easy to find.",
    priority: "Medium",
    status: "In progress",
    assignee: "Alex Morgan",
    initials: "AM",
    team: "Product",
    label: "Experience",
    updatedAt: "2026-10-04T08:00:00.000Z",
  },
  {
    key: "atlas",
    code: "PR-102",
    title: "Atlas",
    description: "Make search results easier to navigate",
    body: "Bring the most relevant results forward and preserve the active filter when someone opens a ticket and returns to the list.",
    priority: "Low",
    status: "Todo",
    assignee: "Jamie Chen",
    initials: "JC",
    team: "Platform",
    label: "Search",
    updatedAt: "2026-10-04T08:00:00.000Z",
  },
  {
    key: "beacon",
    code: "PR-103",
    title: "Beacon",
    description: "Refine delivery notifications",
    body: "Give workspace members timely, useful updates about the work they follow. Group related changes and keep notification copy concise.",
    priority: "Medium",
    status: "In progress",
    assignee: "Sam Rivera",
    initials: "SR",
    team: "Platform",
    label: "Notifications",
    updatedAt: "2026-10-04T08:00:00.000Z",
  },
  {
    key: "meridian",
    code: "PR-104",
    title: "Meridian",
    description: "Review workspace access controls",
    body: "Review administrative permissions and document the access boundaries for shared workspaces. This ticket is owned by the Security team and is read-only for your account.",
    priority: "High",
    status: "Backlog",
    assignee: "Taylor Reed",
    initials: "TR",
    team: "Security",
    label: "Permissions",
    updatedAt: "2026-10-04T08:00:00.000Z",
  },
] as const;
export type Ticket = Omit<(typeof fixtures)[number], "priority" | "updatedAt"> & {
  priority: Priority;
  version: number;
  updatedAt: string;
  canEdit: boolean;
};
