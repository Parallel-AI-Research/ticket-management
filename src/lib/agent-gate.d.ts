import type { ClientEvent, Declaration } from "./domain";
export type SessionInfo = {
  pseudonym: string;
  runId: string;
  sessionId: string;
  fixtureMode: boolean;
  packageMode?: "optional" | "required" | null;
};
declare global {
  interface Window {
    AgentGate?: {
      ready: Promise<SessionInfo | null>;
      policy: string;
      register(declaration: Declaration & { sessionId?: string }): Promise<unknown>;
      status(): Promise<{ accepted: boolean; sessionId: string }>;
      challenge(): Promise<unknown>;
      track(event: ClientEvent): Promise<void>;
      restart(): Promise<SessionInfo>;
    };
  }
}
