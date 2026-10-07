import { createHash, randomUUID } from "node:crypto";

const endpoints = {
  "/api/agent-registration": { method: "POST", operation: "registration_submission" },
  "/api/agent-registration/status": { method: "GET", operation: "registration_status" },
  "/api/agent-registration/challenge": { method: "POST", operation: "registration_challenge" },
  "/api/agent-policy": { method: "GET", operation: "policy_read" },
  "/.well-known/agent-policy": { method: "GET", operation: "policy_read" },
} as const;
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const resultCodes = new Set([
  "accepted",
  "challenge_issued",
  "registration_status_read",
  "policy_served",
  "json_required",
  "request_too_large",
  "invalid_json",
  "origin_not_allowed",
  "supabase_not_configured",
  "sign_in_required",
  "session_required",
  "session_expired",
  "invalid_declaration",
  "session_id_required",
  "session_mismatch",
  "invalid_nonce",
  "new_exchange_required",
  "not_found",
  "method_not_allowed",
  "options",
  "service_unavailable",
]);

export type SetRequestLogResult = (code: unknown) => void;

function browserBinding(request: Request) {
  const cookie = request.headers.get("cookie");
  if (!cookie || cookie.length > 16384) return null;
  let value: string | undefined;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() === "parallel_research_session")
      value = part.slice(separator + 1).trim();
  }
  if (!value || value.length > 256) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  // These are the generated session token's format and length. This untrusted
  // cookie hash is correlation only, never authentication or proof of authorship.
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return createHash("sha256").update(value).digest("hex");
}

/** Logs request arrival, not agent identity or proof of who sent it. */
export async function withAgentRequestLog(
  request: Request,
  handler: (setResult: SetRequestLogResult) => Response | Promise<Response>,
  write: (line: string) => void = (line) => console.info(line),
) {
  const pathname = new URL(request.url).pathname;
  if (!Object.hasOwn(endpoints, pathname)) return handler(() => {});
  const endpoint = pathname as keyof typeof endpoints;
  const configuration = endpoints[endpoint];
  const method = methods.has(request.method) ? request.method : "OTHER";
  const operation =
    method === configuration.method ||
    (method === "HEAD" && endpoint === "/.well-known/agent-policy")
      ? configuration.operation
      : "unsupported_method";
  const fields = {
    event: "agent_request",
    requestId: randomUUID(),
    endpoint,
    method,
    operation,
    browserBinding: browserBinding(request),
  };
  const startedAt = performance.now();
  const emit = (extra: Record<string, string | number | null>) =>
    write(JSON.stringify({ ...fields, timestamp: new Date().toISOString(), ...extra }));
  emit({ phase: "received" });
  let resultCode = "response_returned";
  let response: Response;
  try {
    response = await handler((code) => {
      resultCode = typeof code === "string" && resultCodes.has(code) ? code : "unclassified_result";
    });
  } catch (error) {
    // No response exists yet; the framework controls the eventual HTTP status.
    emit({
      phase: "completed",
      status: null,
      resultCode: "handler_threw",
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
  emit({
    phase: "completed",
    status: response.status,
    resultCode,
    durationMs: Math.round(performance.now() - startedAt),
  });
  response.headers.set("X-Research-Request-Id", fields.requestId);
  return response;
}
