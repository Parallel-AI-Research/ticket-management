import assert from "node:assert/strict";
import { test } from "node:test";
import type { Declaration } from "../src/lib/domain";
import {
  createDeclarationTool,
  publishDeclarationTool,
  type DeclarationTool,
} from "../src/lib/research/webmcp";

const session = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  pseudonym: "R17",
  fixtureMode: false,
};
const eventId = "00000000-0000-4000-8000-000000000003";
const declaration: Declaration = {
  agentName: "Codex",
  actingFor: "R17",
  sources: ["user_instruction", "current_website"],
};

function harness() {
  const submissions: unknown[] = [];
  let confirmations = 0;
  const gate = {
    ready: Promise.resolve<typeof session | null>(session),
    async register(payload: Declaration & { sessionId: string }) {
      submissions.push(payload);
      return { status: 200, code: "accepted", eventId, extra: "must-not-be-returned" };
    },
    async status() {
      confirmations += 1;
      return { accepted: true, sessionId: session.sessionId };
    },
  };
  return { gate, submissions, confirmations: () => confirmations };
}

test("advertising a declaration tool never submits or confirms a declaration", () => {
  const h = harness();
  const tool = createDeclarationTool(
    () => h.gate,
    () => true,
  );
  assert.equal(tool.name, "declare_agent");
  assert.equal(typeof tool.description, "string");
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
  const schema = JSON.parse(JSON.stringify(tool.inputSchema));
  assert.deepEqual(schema.required.slice().sort(), ["actingFor", "agentName", "sources"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(JSON.stringify(schema).includes('"default"'), false);
  assert.equal(Object.hasOwn(schema.properties, "sessionId"), false);
});

test("an explicit declaration preserves supplied fields, binds the current session, and confirms acceptance", async () => {
  const h = harness();
  const tool = createDeclarationTool(
    () => h.gate,
    () => true,
  );
  const supplied = structuredClone(declaration);
  const result = await tool.execute(supplied);
  assert.deepEqual(h.submissions, [{ ...declaration, sessionId: session.sessionId }]);
  assert.deepEqual(supplied, declaration);
  assert.equal(h.confirmations(), 1);
  assert.deepEqual(result, { accepted: true, sessionId: session.sessionId, eventId });
});

test("withheld declaration values remain valid and are not replaced by guessed identity", async () => {
  const h = harness();
  const withheld: Declaration = {
    agentName: "Not disclosed",
    actingFor: "Unknown",
    sources: ["not_disclosed"],
  };
  await createDeclarationTool(
    () => h.gate,
    () => true,
  ).execute(withheld);
  assert.deepEqual(h.submissions, [{ ...withheld, sessionId: session.sessionId }]);
});

test("extra or missing declaration fields and invalid sources fail before backend requests", async () => {
  const invalid = [
    { ...declaration, privatePrompt: "must-not-submit" },
    { ...declaration, sessionId: "00000000-0000-4000-8000-000000000099" },
    { actingFor: "R17", sources: ["current_website"] },
    { ...declaration, agentName: " " },
    { ...declaration, sources: [] },
    { ...declaration, sources: ["https://private.example/"] },
  ];
  for (const value of invalid) {
    const h = harness();
    await assert.rejects(async () =>
      createDeclarationTool(
        () => h.gate,
        () => true,
      ).execute(value),
    );
    assert.deepEqual(h.submissions, []);
    assert.equal(h.confirmations(), 0);
  }
});

test("an inactive route or unavailable SDK cannot submit", async () => {
  const h = harness();
  await assert.rejects(async () =>
    createDeclarationTool(
      () => h.gate,
      () => false,
    ).execute(declaration),
  );
  await assert.rejects(async () =>
    createDeclarationTool(
      () => undefined,
      () => true,
    ).execute(declaration),
  );
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("a missing session cannot submit", async () => {
  const h = harness();
  h.gate.ready = Promise.resolve(null);
  await assert.rejects(async () =>
    createDeclarationTool(
      () => h.gate,
      () => true,
    ).execute(declaration),
  );
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("leaving the experiment while session initialization is pending cannot submit", async () => {
  const h = harness();
  let active = true;
  let resolveSession!: (value: typeof session) => void;
  h.gate.ready = new Promise((resolve) => {
    resolveSession = resolve;
  });
  const submission = createDeclarationTool(
    () => h.gate,
    () => active,
  ).execute(declaration);
  active = false;
  resolveSession(session);
  await assert.rejects(async () => submission);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("a rejected registration request cannot produce acceptance or a status confirmation", async () => {
  const h = harness();
  h.gate.register = async () => {
    throw new Error("session_mismatch");
  };
  await assert.rejects(
    async () =>
      createDeclarationTool(
        () => h.gate,
        () => true,
      ).execute(declaration),
    /session_mismatch/,
  );
  assert.equal(h.confirmations(), 0);
});

test("unaccepted or different-session status cannot report successful registration", async () => {
  for (const status of [
    { accepted: false, sessionId: session.sessionId },
    { accepted: true, sessionId: "00000000-0000-4000-8000-000000000099" },
  ]) {
    const h = harness();
    h.gate.status = async () => status;
    await assert.rejects(async () =>
      createDeclarationTool(
        () => h.gate,
        () => true,
      ).execute(declaration),
    );
    assert.deepEqual(h.submissions, [{ ...declaration, sessionId: session.sessionId }]);
  }
});

test("a failed confirmation request remains a failure after an accepted POST", async () => {
  const h = harness();
  h.gate.status = async () => {
    throw new Error("status_unavailable");
  };
  await assert.rejects(
    async () =>
      createDeclarationTool(
        () => h.gate,
        () => true,
      ).execute(declaration),
    /status_unavailable/,
  );
  assert.deepEqual(h.submissions, [{ ...declaration, sessionId: session.sessionId }]);
});

test("an unsupported runtime performs no SDK lookup or registration work", async () => {
  const publication = publishDeclarationTool(
    undefined,
    () => {
      throw new Error("Unexpected SDK lookup");
    },
    () => {
      throw new Error("Unexpected active-state lookup");
    },
  );
  await publication.ready;
  publication.dispose();
});

test("disposing before publication cancels the tool registration", async () => {
  let publications = 0;
  const h = harness();
  const publication = publishDeclarationTool(
    {
      registerTool() {
        publications += 1;
      },
    },
    () => h.gate,
    () => true,
  );
  publication.dispose();
  await publication.ready;
  assert.equal(publications, 0);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("disposal aborts the published registration and invalidates a retained execute callback", async () => {
  const h = harness();
  let captured!: DeclarationTool;
  let signal!: AbortSignal;
  let aborts = 0;
  const publication = publishDeclarationTool(
    {
      registerTool(tool, options) {
        captured = tool;
        signal = options.signal;
        signal.addEventListener("abort", () => {
          aborts += 1;
        });
      },
    },
    () => h.gate,
    () => true,
  );
  await publication.ready;
  assert.equal(signal.aborted, false);
  assert.deepEqual(h.submissions, []);
  publication.dispose();
  publication.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(aborts, 1);
  await assert.rejects(async () => captured.execute(declaration), /tool_unavailable/);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("disposal while an invocation awaits readiness prevents any late submission", async () => {
  const h = harness();
  let resolveSession!: (value: typeof session) => void;
  h.gate.ready = new Promise((resolve) => {
    resolveSession = resolve;
  });
  let captured!: DeclarationTool;
  const publication = publishDeclarationTool(
    {
      registerTool(tool) {
        captured = tool;
      },
    },
    () => h.gate,
    () => true,
  );
  await publication.ready;
  const execution = captured.execute(declaration);
  publication.dispose();
  resolveSession(session);
  await assert.rejects(async () => execution, /tool_unavailable/);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("replacing readiness while an invocation waits rejects stale session submission", async () => {
  const h = harness();
  let resolveOriginal!: (value: typeof session) => void;
  h.gate.ready = new Promise((resolve) => {
    resolveOriginal = resolve;
  });
  const execution = createDeclarationTool(
    () => h.gate,
    () => true,
  ).execute(declaration);
  h.gate.ready = Promise.resolve({ ...session, sessionId: "00000000-0000-4000-8000-000000000099" });
  resolveOriginal(session);
  await assert.rejects(async () => execution, /session_changed/);
  assert.deepEqual(h.submissions, []);
  assert.equal(h.confirmations(), 0);
});

test("replacing the SDK while an invocation waits rejects the old provider", async () => {
  const original = harness();
  const replacement = harness();
  let current = original.gate;
  let resolveOriginal!: (value: typeof session) => void;
  original.gate.ready = new Promise((resolve) => {
    resolveOriginal = resolve;
  });
  const execution = createDeclarationTool(
    () => current,
    () => true,
  ).execute(declaration);
  current = replacement.gate;
  resolveOriginal(session);
  await assert.rejects(async () => execution, /session_changed/);
  assert.deepEqual(original.submissions, []);
  assert.deepEqual(replacement.submissions, []);
});

test("disposal during an in-flight POST prevents a subsequent confirmation request", async () => {
  const h = harness();
  let finishPost!: (value: Awaited<ReturnType<typeof h.gate.register>>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  h.gate.register = async (payload) => {
    h.submissions.push(payload);
    markStarted();
    return new Promise((resolve) => {
      finishPost = resolve;
    });
  };
  let captured!: DeclarationTool;
  const publication = publishDeclarationTool(
    {
      registerTool(tool) {
        captured = tool;
      },
    },
    () => h.gate,
    () => true,
  );
  await publication.ready;
  const execution = captured.execute(declaration);
  await started;
  publication.dispose();
  finishPost({ status: 200, code: "accepted", eventId, extra: "must-not-be-returned" });
  await assert.rejects(async () => execution);
  assert.equal(h.confirmations(), 0);
  assert.deepEqual(h.submissions, [{ ...declaration, sessionId: session.sessionId }]);
});
