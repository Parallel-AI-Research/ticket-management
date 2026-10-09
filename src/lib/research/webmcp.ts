import { z } from "zod";
import type { SessionInfo } from "../agent-gate";
import { declarationSchema, type Declaration } from "../domain";
import { agentPolicy } from "./policy";

type RegistrationGate = {
  ready: Promise<SessionInfo | null>;
  register(declaration: Declaration & { sessionId: string }): Promise<unknown>;
  status(): Promise<{ accepted: boolean; sessionId: string }>;
};

const acceptedResponse = z.object({ code: z.literal("accepted"), eventId: z.uuid() });

/** Publishing this definition does not invoke it or fill any declaration fields. */
export function createDeclarationTool(
  getGate: () => RegistrationGate | undefined,
  isActive: () => boolean,
) {
  return {
    name: "declare_agent",
    description:
      "Declare yourself as an automated assistant before preparing ticket changes in this workspace. " +
      "Explicitly supply your agent label, research pseudonym and source categories. " +
      "Unknown, Not disclosed and Not applicable are accepted. " +
      "This stores your self-reported declaration in the current signed-in session and confirms acceptance. " +
      "It does not save tickets or change account permissions. " +
      agentPolicy.privacy,
    inputSchema: z.toJSONSchema(declarationSchema),
    annotations: { readOnlyHint: false },
    async execute(input: unknown) {
      const parsed = declarationSchema.safeParse(input);
      if (!parsed.success) throw new Error("invalid_declaration");
      if (!isActive()) throw new Error("tool_unavailable");
      const gate = getGate();
      if (!gate) throw new Error("session_required");
      const ready = gate.ready;
      const session = await ready;
      if (!isActive()) throw new Error("tool_unavailable");
      if (!session) throw new Error("session_required");
      if (getGate() !== gate || gate.ready !== ready) throw new Error("session_changed");
      // This is transport binding, never an identity supplied on the agent's behalf.
      // The backend rejects the request if another tab has replaced the cookie session.
      const result = acceptedResponse.safeParse(
        await gate.register({ ...parsed.data, sessionId: session.sessionId }),
      );
      if (!result.success) throw new Error("registration_not_accepted");
      if (!isActive() || getGate() !== gate || gate.ready !== ready)
        throw new Error("session_changed");
      const confirmation = await gate.status();
      if (!confirmation.accepted || confirmation.sessionId !== session.sessionId)
        throw new Error("registration_not_confirmed");
      if (!isActive() || getGate() !== gate || gate.ready !== ready)
        throw new Error("session_changed");
      return { accepted: true, sessionId: session.sessionId, eventId: result.data.eventId };
    },
  };
}

export type DeclarationTool = ReturnType<typeof createDeclarationTool>;
export type SiteModelContext = {
  registerTool(tool: DeclarationTool, options: { signal: AbortSignal }): Promise<void> | void;
};

/** Abort removes the tool in implementations supporting the current WebMCP API. */
export function publishDeclarationTool(
  context: SiteModelContext | undefined,
  getGate: () => RegistrationGate | undefined,
  isActive: () => boolean,
) {
  const controller = new AbortController();
  const tool = createDeclarationTool(getGate, () => !controller.signal.aborted && isActive());
  const ready = context
    ? Promise.resolve().then(() => {
        if (controller.signal.aborted) return;
        return context.registerTool(tool, { signal: controller.signal });
      })
    : Promise.resolve();
  return { ready, dispose: () => controller.abort() };
}
