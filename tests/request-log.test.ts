import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { withAgentRequestLog } from "../src/lib/research/request-log";

const capture = () => {
  const records: Record<string, unknown>[] = [];
  return { records, write: (line: string) => records.push(JSON.parse(line)) };
};

test("entry precedes validation and completion pairs the request without reading private data", async () => {
  const { records, write } = capture();
  const request = new Request("https://example.test/api/agent-registration?nonce=private-query", {
    method: "POST",
    headers: { authorization: "Bearer private-token", cookie: "private-cookie" },
    body: "private-declaration",
  });
  const response = await withAgentRequestLog(
    request,
    (setResult) => {
      assert.equal(records.length, 1);
      assert.equal(records[0].phase, "received");
      assert.equal(request.bodyUsed, false);
      setResult("sign_in_required");
      return Response.json(
        { code: "sign_in_required", ignored: "private-response" },
        { status: 401 },
      );
    },
    write,
  );
  assert.equal(response.status, 401);
  assert.equal(response.bodyUsed, false);
  assert.equal(records.length, 2);
  assert.equal(records[0].requestId, records[1].requestId);
  assert.equal(response.headers.get("X-Research-Request-Id"), records[0].requestId);
  assert.match(String(records[0].requestId), /^[0-9a-f-]{36}$/);
  assert.equal(records[1].resultCode, "sign_in_required");
  assert.equal(records[1].status, 401);
  assert.equal(records[1].operation, "registration_submission");
  assert.ok(Number(records[1].durationMs) >= 0);
  assert.equal(JSON.stringify(records).includes("private-"), false);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    "browserBinding",
    "endpoint",
    "event",
    "method",
    "operation",
    "phase",
    "requestId",
    "timestamp",
  ]);
  assert.deepEqual(Object.keys(records[1]).sort(), [
    "browserBinding",
    "durationMs",
    "endpoint",
    "event",
    "method",
    "operation",
    "phase",
    "requestId",
    "resultCode",
    "status",
    "timestamp",
  ]);
});

test("browser correlation hashes only the bounded research cookie and ignores invalid values", async () => {
  const token = "abcdef01".repeat(8);
  const expected = createHash("sha256").update(token).digest("hex");
  const cases: [string | null, string | null][] = [
    [`auth=private-auth; parallel_research_session=${token}; other=private-other`, expected],
    [`parallel_research_session=${"b".repeat(64)}; parallel_research_session=${token}`, expected],
    [null, null],
    ["parallel_research_session=private-invalid", null],
    [`parallel_research_session=${"a".repeat(257)}`, null],
    ["parallel_research_session=%broken", null],
  ];
  for (const [cookie, binding] of cases) {
    const { records, write } = capture();
    await withAgentRequestLog(
      new Request("https://example.test/api/agent-registration", {
        method: "POST",
        headers: cookie ? { cookie } : {},
      }),
      () => new Response(null, { status: 401 }),
      write,
    );
    assert.equal(records[0].browserBinding, binding);
    assert.equal(records[1].browserBinding, binding);
    assert.equal(JSON.stringify(records).includes(token), false);
    assert.equal(JSON.stringify(records).includes("private-"), false);
  }
});

test("status polling, challenge, policy and unsupported methods remain distinct", async () => {
  const cases = [
    ["/api/agent-registration", "POST", "registration_submission"],
    ["/api/agent-registration/form", "POST", "registration_submission"],
    ["/api/agent-registration/require", "POST", "registration_requirement"],
    ["/experiments/v4/agent-policy", "GET", "policy_read"],
    ["/experiments/v1/agent-policy", "GET", "policy_read"],
    ["/experiments/v2/agent-policy", "GET", "policy_read"],
    ["/experiments/v3/agent-policy", "GET", "policy_read"],
    ["/api/agent-registration/status", "GET", "registration_status"],
    ["/api/agent-registration/challenge", "POST", "registration_challenge"],
    ["/api/agent-policy", "GET", "policy_read"],
    ["/.well-known/agent-policy", "GET", "policy_read"],
    ["/.well-known/agent-policy", "HEAD", "policy_read"],
    ["/api/agent-registration", "GET", "unsupported_method"],
    ["/api/agent-registration/challenge", "OPTIONS", "unsupported_method"],
  ];
  const ids = new Set();
  for (const [endpoint, method, operation] of cases) {
    const { records, write } = capture();
    await withAgentRequestLog(
      new Request(`https://example.test${endpoint}`, { method }),
      () => new Response(null, { status: 204 }),
      write,
    );
    assert.equal(records[0].operation, operation);
    assert.equal(records[0].endpoint, endpoint);
    assert.equal(records[0].method, method);
    ids.add(records[0].requestId);
  }
  assert.equal(ids.size, cases.length);
});

test("unknown paths and lookalikes are not logged", async () => {
  const { records, write } = capture();
  for (const path of [
    "/api/auth/login",
    "/api/agent-registration/private-id",
    "/api/agent-policy-extra",
    "/experiments/private-id/agent-policy",
  ]) {
    const response = await withAgentRequestLog(
      new Request(`https://example.test${path}`),
      () => new Response(null, { status: 404 }),
      write,
    );
    assert.equal(response.status, 404);
  }
  assert.deepEqual(records, []);
});

test("arbitrary result codes cannot leak handler data", async () => {
  const { records, write } = capture();
  await withAgentRequestLog(
    new Request("https://example.test/api/agent-registration", { method: "POST" }),
    (setResult) => {
      setResult("private-nonce");
      return new Response(null, { status: 422 });
    },
    write,
  );
  assert.equal(records[1].resultCode, "unclassified_result");
  assert.equal(JSON.stringify(records).includes("private-nonce"), false);
});

test("unexpected handler failure pairs entry and completion without exposing the error", async () => {
  const { records, write } = capture();
  const failure = new Error("private-connection-string");
  await assert.rejects(
    withAgentRequestLog(
      new Request("https://example.test/api/agent-registration", { method: "POST" }),
      () => {
        throw failure;
      },
      write,
    ),
    (error) => error === failure,
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].requestId, records[1].requestId);
  assert.equal(records[1].phase, "completed");
  assert.equal(records[1].resultCode, "handler_threw");
  assert.equal(records[1].status, null);
  assert.equal(JSON.stringify(records).includes("private-connection-string"), false);
});
