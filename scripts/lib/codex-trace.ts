import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,240}$/;
const CALLS = new Set(["function_call", "custom_tool_call"]);
const RESULTS = new Set(["function_call_output", "custom_tool_call_output"]);

export type CodexTraceOptions = {
  expectedThreadId: string;
  startedAt: string;
  endedAt: string;
  /** Exact namespace.name (or name when no namespace is recorded), frozen before capture. */
  allowedTools: readonly string[];
  /** Known trial credentials/nonces, supplied in memory; never included in the artifact. */
  sensitiveValues: readonly string[];
  unsafeHandling?: "reject" | "omit";
};

type ToolRecord = {
  ordinal: number;
  recordedAt: string;
  phase: "call" | "result";
  callId: string;
  itemId?: string;
  tool: string | null;
  body?: unknown;
  bodyOmitted?: "tool_not_allowlisted" | "sensitive_or_private_content" | "unpaired_result";
};

type TraceMetadata = {
  threadId: string;
  createdAt: string | null;
  cliVersion: string | null;
  originator: string | null;
  modelProvider: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function time(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
    throw new Error("Trace timestamps must include a timezone.");
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("Invalid trace timestamp.");
  return result;
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    throw new Error("Unsupported tool identifier in rollout.");
  return value;
}

function encodedSensitiveValues(values: readonly string[]) {
  const forms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const base = new Set([value]);
    // Tool arguments can contain JavaScript inside JSON, and URLs can encode credentials again.
    // Match common reversible encodings without decoding or copying unrelated tool content.
    try {
      base.add(encodeURIComponent(value));
      base.add(encodeURI(value));
      base.add(new URLSearchParams({ value }).toString().slice("value=".length));
    } catch {
      // Lone UTF-16 surrogates cannot be URI-encoded; raw and JSON forms still apply.
    }
    base.add(
      value
        .replaceAll("\\", "\\\\")
        .replaceAll("'", "\\'")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r"),
    );
    for (const candidate of base) {
      for (const form of [
        candidate,
        candidate.replace(/%[0-9a-f]{2}/gi, (part) => part.toLowerCase()),
      ]) {
        let escaped = form;
        for (let depth = 0; depth <= 3; depth++) {
          forms.add(escaped);
          escaped = JSON.stringify(escaped).slice(1, -1);
        }
      }
    }
  }
  return [...forms];
}

function unsafeBody(value: unknown, sensitiveForms: readonly string[]) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return true;
  if (sensitiveForms.some((form) => text.includes(form))) return true;
  // Conservative refusal, not a guarantee of automatic redaction. Unknown private content still
  // requires operator review. Never retain screenshots, nested transcripts, credentials or nonces.
  const normalized = text.replaceAll('\\"', '"').replaceAll("\\'", "'");
  return [
    /(?:authorization|proxy-authorization|cookie|set-cookie)["'\s]*[:=]/i,
    /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|operator[_-]?token|nonce)["'\s]*[:=]/i,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/i,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /(?:postgres(?:ql)?|https?):\/\/[^\s/]+:[^\s/]+@/i,
    /\b(?:github_pat_|gh[pousr]_|sb_secret_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/,
    /["']role["']\s*:\s*["'](?:user|developer|system)["']/i,
    /["']type["']\s*:\s*["'](?:reasoning|input_image|output_image|image)["']/i,
    /data:image\//i,
  ].some((pattern) => pattern.test(normalized));
}

function metadataText(value: unknown, format: RegExp, sensitiveForms: readonly string[]) {
  return typeof value === "string" &&
    value.length <= 64 &&
    format.test(value) &&
    !unsafeBody(value, sensitiveForms)
    ? value
    : null;
}

/** Pure, versioned projection. No messages, reasoning, prompts, or passthrough metadata survive. */
export function extractCodexToolTrace(jsonl: string, options: CodexTraceOptions) {
  if (!UUID.test(options.expectedThreadId)) throw new Error("Supply an exact trial thread UUID.");
  const start = time(options.startedAt),
    end = time(options.endedAt);
  if (end < start) throw new Error("Trace window ends before it starts.");
  if (Buffer.byteLength(jsonl) > MAX_ROLLOUT_BYTES) throw new Error("Rollout exceeds 64 MiB.");
  const allowed = new Set(options.allowedTools.map(identifier));
  const sensitiveForms = encodedSensitiveValues(options.sensitiveValues);
  let metadata: TraceMetadata | null = null;
  const records: ToolRecord[] = [];
  const calls = new Map<string, ToolRecord>();
  const results = new Set<string>();
  let previousOrdinal = -1;
  let partialTail = false;
  const lines = jsonl.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = object(JSON.parse(line));
    } catch {
      if (index === lines.length - 1 && !jsonl.endsWith("\n")) {
        partialTail = true;
        break;
      }
      throw new Error("Malformed rollout record; no trace was exported.");
    }
    if (!entry) throw new Error("Unsupported rollout record.");
    const payload = object(entry.payload);
    if (entry.type === "session_meta") {
      if (metadata || payload?.id !== options.expectedThreadId)
        throw new Error("Rollout does not identify exactly the requested trial thread.");
      const createdAt = metadataText(
        payload.timestamp,
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/,
        sensitiveForms,
      );
      metadata = {
        threadId: options.expectedThreadId,
        createdAt: createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
        cliVersion: metadataText(
          payload.cli_version,
          /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/,
          sensitiveForms,
        ),
        originator: metadataText(
          payload.originator,
          /^(?:Codex Desktop|Codex CLI|codex_cli_rs|codex_vscode)$/,
          sensitiveForms,
        ),
        modelProvider: metadataText(
          payload.model_provider,
          /^(?:openai|ollama|lmstudio)$/,
          sensitiveForms,
        ),
      };
      continue;
    }
    // Deliberately drop whole records before selecting any content fields.
    if (entry.type !== "response_item" || !payload || typeof payload.type !== "string") continue;
    if (!CALLS.has(payload.type) && !RESULTS.has(payload.type)) continue;
    if (!metadata) throw new Error("Tool record precedes verified trial metadata.");
    const at = time(entry.timestamp);
    if (at < start || at > end) continue;
    if (!Number.isSafeInteger(entry.ordinal) || (entry.ordinal as number) <= previousOrdinal)
      throw new Error("Tool ordinals are missing, duplicated, or out of order.");
    previousOrdinal = entry.ordinal as number;
    const callId = identifier(payload.call_id);
    const isCall = CALLS.has(payload.type);
    let tool: string | null;
    if (isCall) {
      if (calls.has(callId)) throw new Error("Duplicate tool call ID in capture window.");
      tool =
        (typeof payload.namespace === "string" ? identifier(payload.namespace) + "." : "") +
        identifier(payload.name);
    } else {
      if (results.has(callId)) throw new Error("Duplicate tool result ID in capture window.");
      results.add(callId);
      tool = calls.get(callId)?.tool ?? null;
    }
    const record: ToolRecord = {
      ordinal: entry.ordinal as number,
      recordedAt: entry.timestamp as string,
      phase: isCall ? "call" : "result",
      callId,
      ...(typeof payload.id === "string" ? { itemId: identifier(payload.id) } : {}),
      tool,
    };
    const body = isCall
      ? payload.type === "function_call"
        ? payload.arguments
        : payload.input
      : payload.output;
    if (!tool) record.bodyOmitted = "unpaired_result";
    else if (!allowed.has(tool)) record.bodyOmitted = "tool_not_allowlisted";
    else if (unsafeBody(body, sensitiveForms)) {
      if (options.unsafeHandling !== "omit")
        throw new Error("Sensitive or private tool content detected; no trace was exported.");
      record.bodyOmitted = "sensitive_or_private_content";
    } else record.body = body;
    if (isCall) calls.set(callId, record);
    records.push(record);
  }
  if (!metadata) throw new Error("Missing trial session metadata.");
  const unmatchedCallIds = [...calls.keys()].filter((id) => !results.has(id));
  const unpairedResultIds = [...results].filter((id) => !calls.has(id));
  return {
    schemaVersion: "codex-passive-tools-v1" as const,
    source: { kind: "codex_local_rollout" as const, ...metadata },
    window: { startedAt: options.startedAt, endedAt: options.endedAt },
    allowedTools: [...allowed],
    records,
    integrity: {
      partialTail,
      unmatchedCallIds,
      unpairedResultIds,
      omittedBodyCount: records.filter((record) => record.bodyOmitted).length,
      sourceCompleteness: "unverified" as const,
      operatorContentReviewRequired: true,
    },
    limitations: [
      "Passive projection of one explicitly identified local runtime rollout; local files are mutable and this is not a signed attestation.",
      "Timestamps record runtime events, not independent HTTP submission times. Batched code-mode calls require independent interpretation.",
      "Only allowlisted tool bodies are retained. Omitted bodies, unmatched calls, partial tails and unobserved browser state limit evidence coverage.",
      "No inference about fresh context, memory, browser isolation, model revision or successful registration follows from this artifact alone.",
      "Sensitive-content detection is conservative and incomplete; review retained tool content before persistence or sharing.",
    ],
  };
}

/** Read one caller-supplied, exact-ID path. Never discover files or enumerate other chats. */
export async function readCodexToolTrace(rolloutPath: string, options: CodexTraceOptions) {
  if (
    !path.isAbsolute(rolloutPath) ||
    !UUID.test(options.expectedThreadId) ||
    !path.basename(rolloutPath).endsWith(`-${options.expectedThreadId}.jsonl`)
  )
    throw new Error("Supply the explicit absolute rollout path for the expected trial thread.");
  const handle = await open(
    rolloutPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ROLLOUT_BYTES)
      throw new Error("Rollout must be a regular file no larger than 64 MiB.");
    // Bound the read to this snapshot, even while the runtime appends additional events.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Rollout changed during capture; retry the scoped snapshot.");
      offset += bytesRead;
    }
    return extractCodexToolTrace(bytes.toString("utf8"), options);
  } finally {
    await handle.close();
  }
}
