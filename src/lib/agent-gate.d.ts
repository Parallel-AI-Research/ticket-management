import type { ClientEvent, Declaration } from "./domain";
export type SessionInfo = {
  pseudonym: string;
  runId: string;
  sessionId: string;
  fixtureMode: boolean;
};
declare global {
  interface Window {
    AgentGate?: {
      ready: Promise<SessionInfo | null>;
      policy: string;
      register(declaration: Declaration): Promise<unknown>;
      status(): Promise<{ accepted: boolean }>;
      challenge(): Promise<unknown>;
      track(event: ClientEvent): Promise<void>;
      restart(): Promise<SessionInfo>;
    };
  }
}
