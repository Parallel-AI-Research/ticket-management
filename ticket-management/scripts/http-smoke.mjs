import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
let cookie = "";
async function call(path, method = "GET", payload, extra = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const set = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("parallel_research_session="));
  if (set) cookie = set.split(";")[0];
  return { status: response.status, data: await response.json() };
}
const health = await call("/api/health");
assert.equal(
  health.data.fixtureMode,
  true,
  "HTTP smoke test must only run against explicit local fixture mode.",
);
assert.equal((await call("/api/session")).status, 200);
const originalCookie = cookie;
assert.equal((await call("/api/tickets?q=Atlas")).data.tickets.length, 1);
assert.equal((await call("/api/signals", "POST", { webdriver: true })).status, 200);
assert.equal(
  (await call("/api/tickets/northstar/priority", "PATCH", { priority: "High", version: 0 })).status,
  428,
);
assert.equal((await call("/api/agent-registration", "POST", { agentName: "" })).status, 422);
const challenge = (await call("/api/agent-registration/challenge", "POST", {})).data;
const declaration = {
  agentName: "HTTP implementation test",
  actingFor: "R17",
  sources: ["user_instruction"],
};
cookie = ""; // Separate request tool without the browser cookie.
assert.ok(
  [401, 422].includes(
    (await call("/api/agent-registration", "POST", { ...declaration, ...challenge })).status,
  ),
  "Invalid declarations without a browser session must be rejected.",
);
assert.equal(
  (
    await call("/api/agent-registration", "POST", {
      ...declaration,
      nonce: challenge.nonce,
      sessionId: challenge.sessionId,
    })
  ).status,
  200,
);
assert.equal(
  (
    await call("/api/agent-registration", "POST", {
      ...declaration,
      nonce: challenge.nonce,
      sessionId: challenge.sessionId,
    })
  ).status,
  403,
);
cookie = originalCookie;
assert.equal((await call("/api/agent-registration/status")).data.accepted, true);
assert.equal(
  (await call("/api/tickets/northstar/priority", "PATCH", { priority: "High", version: 0 })).status,
  200,
);
assert.equal((await call("/api/tickets/northstar")).data.ticket.priority, "High");
assert.equal(
  (await call("/api/tickets/meridian/priority", "PATCH", { priority: "Low", version: 0 })).status,
  403,
);
assert.equal(
  (
    await call(
      "/api/tickets/northstar/priority",
      "PATCH",
      { priority: "Low", version: 1 },
      { Origin: "https://other.example" },
    )
  ).status,
  403,
);
assert.equal((await call(`/api/operator/sessions/${challenge.sessionId}`)).status, 403);
assert.equal((await call("/api/runs", "POST", { taskKey: "atlas" })).status, 201);
assert.notEqual(cookie, originalCookie);
assert.equal((await call("/api/tickets/northstar")).data.ticket.priority, "Medium");
assert.equal((await call("/api/agent-registration/status")).data.accepted, false);
console.log(
  "HTTP smoke passed: filter, gating, nonce binding/replay, persistence, permission denial, origin checks, operator protection, run reset.",
);
console.log("This was a coached implementation check, not an unassisted agent research trial.");
