import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractCodexToolTrace,
  readCodexToolTrace,
  type CodexTraceOptions,
} from "../scripts/lib/codex-trace";

const id = "00000000-0000-4000-8000-000000000001";
const options: CodexTraceOptions = {
  expectedThreadId: id,
  startedAt: "2026-10-07T00:00:00Z",
  endedAt: "2026-10-07T00:01:00Z",
  allowedTools: ["mcp__cua_repl.js", "exec"],
  sensitiveValues: ["synthetic-sensitive-literal"],
};
const meta = {
  type: "session_meta",
  payload: {
    id,
    cli_version: "0.160.0",
    originator: "Codex Desktop",
    private: "DO NOT COPY METADATA",
  },
};
const record = <T>(ordinal: number, payload: T, timestamp = "2026-10-07T00:00:10Z") => ({
  timestamp,
  ordinal,
  type: "response_item",
  payload,
});
const call = record(1, {
  type: "function_call",
  name: "js",
  namespace: "mcp__cua_repl",
  call_id: "call-1",
  arguments: '{"code":"await tab.click()"}',
  internal_chat_message_metadata_passthrough: "DO NOT COPY PASSTHROUGH",
});
const result = record(2, {
  type: "function_call_output",
  call_id: "call-1",
  output: "Saved successfully",
});
const jsonl = (...entries: unknown[]) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

test("passive capture retains exact tool bodies and IDs, drops every conversation/reasoning field", () => {
  const source = jsonl(
    meta,
    record(0, { type: "message", role: "user", content: "PRIVATE PROMPT" }),
    record(0, { type: "reasoning", summary: "PRIVATE REASONING", content: "PRIVATE REASONING" }),
    call,
    result,
  );
  const trace = extractCodexToolTrace(source, options);
  assert.equal(trace.records.length, 2);
  assert.equal(trace.records[0].body, call.payload.arguments);
  assert.equal(trace.records[1].body, result.payload.output);
  assert.equal(trace.records[0].callId, trace.records[1].callId);
  assert.deepEqual(trace.integrity.unmatchedCallIds, []);
  assert.equal(trace.integrity.sourceCompleteness, "unverified");
  assert.equal(trace.integrity.operatorContentReviewRequired, true);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|DO NOT COPY/);
});

test("exact thread and explicit time boundaries prevent mixed-session or boundary-spanning credit", () => {
  assert.throws(() =>
    extractCodexToolTrace(jsonl({ ...meta, payload: { id: "wrong" } }, call), options),
  );
  assert.throws(() => extractCodexToolTrace(jsonl(call, meta), options));
  const trace = extractCodexToolTrace(
    jsonl(meta, { ...call, timestamp: "2026-10-06T23:59:59Z" }, result),
    options,
  );
  assert.deepEqual(trace.integrity.unpairedResultIds, ["call-1"]);
  assert.equal(trace.records[0].body, undefined);
  assert.equal(trace.records[0].bodyOmitted, "unpaired_result");
});

test("credentials, headers, nonces, images and nested private transcripts are refused or explicitly lossy", () => {
  for (const body of [
    '{"password":"example"}',
    '{"headers":{"Authorization":"Bearer abcdefghijk"}}',
    '{"nonce":"example"}',
    "synthetic-sensitive-literal",
    "postgres://user:password@db.example/db",
    '{"role":"system","content":"private"}',
    '{"type":"image","data":"base64"}',
  ]) {
    const source = jsonl(meta, { ...call, payload: { ...call.payload, arguments: body } }, result);
    assert.throws(() => extractCodexToolTrace(source, options), /Sensitive or private/);
    const trace = extractCodexToolTrace(source, { ...options, unsafeHandling: "omit" });
    assert.equal(trace.records[0].body, undefined);
    assert.equal(trace.integrity.omittedBodyCount, 1);
    assert.equal(trace.integrity.sourceCompleteness, "unverified");
    assert.equal(trace.records[0].bodyOmitted, "sensitive_or_private_content");
  }
});

test("unlisted tool bodies and their outputs cannot escape the allowlist", () => {
  const source = jsonl(
    meta,
    { ...call, payload: { ...call.payload, name: "read_thread" } },
    result,
  );
  const trace = extractCodexToolTrace(source, options);
  assert.equal(trace.integrity.omittedBodyCount, 2);
  assert.equal(trace.records[0].body, undefined);
  assert.equal(trace.records[1].body, undefined);
});

test("known credentials cannot escape through JSON, nested scripts, or URL encoding", () => {
  const sensitive = 'synthetic "quoted"\nvalue /&+?';
  const scoped = { ...options, sensitiveValues: [sensitive] };
  const encoded = encodeURIComponent(sensitive);
  for (const body of [
    JSON.stringify({ value: sensitive }),
    JSON.stringify({ code: `await tab.fill(${JSON.stringify(sensitive)})` }),
    JSON.stringify({ code: `await tab.fill(${JSON.stringify(JSON.stringify(sensitive))})` }),
    `await tab.fill('${encoded}')`,
    `await tab.fill('${encoded.replace(/%[0-9a-f]{2}/gi, (part) => part.toLowerCase())}')`,
    `https://example.test/?${new URLSearchParams({ value: sensitive })}`,
  ]) {
    const source = jsonl(meta, { ...call, payload: { ...call.payload, arguments: body } }, result);
    assert.throws(() => extractCodexToolTrace(source, scoped), /Sensitive or private/);
    const trace = extractCodexToolTrace(source, { ...scoped, unsafeHandling: "omit" });
    assert.equal(trace.records[0].bodyOmitted, "sensitive_or_private_content");
    assert.equal(trace.records[0].body, undefined);
    assert.equal(trace.integrity.omittedBodyCount, 1);
    assert.equal(trace.integrity.sourceCompleteness, "unverified");
  }
});

test("runtime metadata is bounded and constrained instead of echoing arbitrary payloads", () => {
  const source = jsonl(
    {
      ...meta,
      payload: {
        ...meta.payload,
        timestamp: "PRIVATE METADATA",
        cli_version: "0.160.0-" + "x".repeat(100),
        originator: "PRIVATE METADATA",
        model_provider: "synthetic-sensitive-literal",
      },
    },
    call,
    result,
  );
  const trace = extractCodexToolTrace(source, options);
  assert.equal(trace.source.createdAt, null);
  assert.equal(trace.source.cliVersion, null);
  assert.equal(trace.source.originator, null);
  assert.equal(trace.source.modelProvider, null);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE METADATA|synthetic-sensitive-literal|x{100}/);
  const valid = extractCodexToolTrace(jsonl(meta, call, result), options);
  assert.equal(valid.source.originator, "Codex Desktop");
  assert.equal(valid.source.cliVersion, "0.160.0");
});

test("partial writes, missing results, malformed records and duplicate ordinals are never treated as complete", () => {
  const trace = extractCodexToolTrace(jsonl(meta, call) + '{"type":', options);
  assert.equal(trace.integrity.partialTail, true);
  assert.deepEqual(trace.integrity.unmatchedCallIds, ["call-1"]);
  assert.throws(() => extractCodexToolTrace(jsonl(meta) + "invalid\n" + jsonl(call), options));
  assert.throws(() => extractCodexToolTrace(jsonl(meta, call, { ...result, ordinal: 1 }), options));
  assert.throws(() => extractCodexToolTrace(jsonl(meta, call, { ...call, ordinal: 2 }), options));
});

test("custom code-mode calls preserve source code but do not claim nested action completeness", () => {
  const trace = extractCodexToolTrace(
    jsonl(
      meta,
      record(1, {
        type: "custom_tool_call",
        name: "exec",
        call_id: "batch-1",
        input: "await tools.web__run({});",
      }),
      record(2, { type: "custom_tool_call_output", call_id: "batch-1", output: "done" }),
    ),
    options,
  );
  assert.equal(trace.records[0].tool, "exec");
  assert.equal(trace.records[0].body, "await tools.web__run({});");
  assert.equal(trace.integrity.sourceCompleteness, "unverified");
});

test("reader only opens an explicit exact-ID regular file, leaves source untouched and refuses symlinks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-trace-test-"));
  try {
    const sourcePath = path.join(dir, `rollout-example-${id}.jsonl`);
    const source = jsonl(meta, call, result);
    await writeFile(sourcePath, source);
    const trace = await readCodexToolTrace(sourcePath, options);
    assert.equal(trace.records.length, 2);
    assert.equal(await readFile(sourcePath, "utf8"), source);
    await assert.rejects(readCodexToolTrace(path.join(dir, "other.jsonl"), options));
    const link = path.join(dir, `linked-${id}.jsonl`);
    await symlink(sourcePath, link);
    await assert.rejects(readCodexToolTrace(link, options));
    await assert.rejects(readCodexToolTrace(`relative-${id}.jsonl`, options));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
