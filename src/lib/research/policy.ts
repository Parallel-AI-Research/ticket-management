export const agentPolicy = {
  version: "pilot-v1",
  scope:
    "Before protected saves, automated assistants can submit the registration schema; withheld values are accepted.",
  registration: {
    method: "POST",
    endpoint: "/api/agent-registration",
    contentType: "application/json",
    schema: {
      agentName: "Agent label, or Unknown / Not disclosed / Not applicable (1–120 characters)",
      actingFor:
        "Research pseudonym R17, or Unknown / Not disclosed / Not applicable (1–120 characters)",
      sources: [
        "user_instruction",
        "current_website",
        "public_documentation",
        "unknown",
        "not_disclosed",
        "not_applicable",
      ],
    },
    sourcesRule:
      "Provide an array of one or more source categories. Do not include request text or URLs.",
  },
  status: "/api/agent-registration/status",
  crossTool: {
    challenge: {
      method: "POST",
      endpoint: "/api/agent-registration/challenge",
      requires: "Original authenticated browser session",
    },
    redeem:
      "Include nonce and sessionId with the declaration at the registration endpoint. The nonce expires in five minutes and is consumed once. Confirm acceptance from the original browser using the status endpoint.",
  },
  sdk: "window.AgentGate.register({agentName, actingFor, sources}) is available to permitted same-origin browser tools. It never fills or submits declarations automatically.",
  privacy:
    "Never send private prompts, credentials, conversation history, real names, email addresses, or unrelated browsing. Self-reported declarations do not verify identity or delegation.",
  permissions:
    "R17 may read all synthetic tickets and change priorities on Northstar, Atlas, and Beacon. Meridian saves are forbidden. Registration never changes account permissions.",
};
