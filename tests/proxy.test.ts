import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, type NextFetchEvent } from "next/server";
import { proxy } from "../src/proxy";

const settings = {
  AGENT_ID_API_URL: "https://collector.example",
  AGENT_ID_SITE_ID: "ticket-management",
  AGENT_ID_SITE_SECRET: "synthetic-site-secret-for-proxy-tests-only",
};
const signed = {
  signature: "sig1=:c2lnbmF0dXJl:",
  "signature-input": 'sig1=("@authority" "signature-agent");created=1;keyid="k";tag="web-bot-auth"',
  "signature-agent": 'sig1="https://chatgpt.com"',
  cookie: "private-cookie",
  "user-agent": "Mozilla/5.0",
};
const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[];

function invoke(path: string, headers: Record<string, string>) {
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  const request = new NextRequest(`https://ticket-management.example${path}`, { headers });
  return { pending, response: proxy(request, event as unknown as NextFetchEvent) };
}

beforeEach(() => {
  calls = [];
  Object.assign(process.env, settings);
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ event: { id: "event-1", type: "signature" } });
  }) as typeof fetch;
});
afterEach(() => {
  for (const name of Object.keys(settings)) delete process.env[name];
  globalThis.fetch = realFetch;
});

test("proxy forwards a signed page request's signed headers to the collector", async () => {
  const { pending, response } = invoke("/login", signed);
  await response;
  assert.equal(pending.length, 1);
  assert.deepEqual(await pending[0], {
    status: "recorded",
    event: { id: "event-1", type: "signature" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://collector.example/v1/signatures");
  assert.equal(
    new Headers(calls[0]!.init.headers).get("authorization"),
    `Bearer ${settings.AGENT_ID_SITE_SECRET}`,
  );
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.siteId, "ticket-management");
  assert.equal(body.request.url, "https://ticket-management.example/login");
  // Only what the signature covers leaves the server: no cookie or user agent.
  assert.deepEqual(Object.keys(body.request.headers).sort(), [
    "signature",
    "signature-agent",
    "signature-input",
  ]);
});

test("proxy reports the host the agent signed when Next rewrites the URL's host", async () => {
  const { pending, response } = invoke("/login", { ...signed, host: "127.0.0.1:4311" });
  await response;
  await Promise.all(pending);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.request.url, "https://127.0.0.1:4311/login");
});

test("proxy makes no collector call for unsigned requests", async () => {
  const { pending, response } = invoke("/tickets", { "user-agent": "Mozilla/5.0" });
  await response;
  await Promise.all(pending);
  assert.equal(calls.length, 0);
});

test("proxy skips signed requests when the collector isn't configured", async () => {
  delete process.env.AGENT_ID_SITE_SECRET;
  const { pending, response } = invoke("/login", signed);
  await response;
  assert.equal(pending.length, 0);
  assert.equal(calls.length, 0);
});
