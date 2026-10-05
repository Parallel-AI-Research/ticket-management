import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

class SmokeFailure extends Error {}
const check = (condition, message) => {
  if (!condition) throw new SmokeFailure(message);
};

function settings() {
  const { TEST_BASE_URL, TEST_USER_EMAIL, TEST_USER_PASSWORD } = process.env;
  check(
    TEST_BASE_URL && TEST_USER_EMAIL && TEST_USER_PASSWORD,
    "Set TEST_BASE_URL, TEST_USER_EMAIL, and TEST_USER_PASSWORD before running the live check.",
  );
  let base;
  try {
    base = new URL(TEST_BASE_URL);
  } catch {
    throw new SmokeFailure("TEST_BASE_URL must be a valid application origin.");
  }
  check(
    !base.username && !base.password && !base.search && !base.hash && base.pathname === "/",
    "TEST_BASE_URL must contain only the application origin, without credentials, path, or query.",
  );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  check(
    base.protocol === "https:" || (base.protocol === "http:" && loopback),
    "Live credentials require HTTPS; HTTP is allowed only for a loopback development server.",
  );
  return { base, email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD };
}

function updateCookies(jar, headers) {
  for (const value of headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const expired = attributes.some((attribute) => {
      const [key, ...parts] = attribute.trim().split("=");
      if (key.toLowerCase() === "max-age") return Number(parts.join("=")) <= 0;
      if (key.toLowerCase() === "expires") return Date.parse(parts.join("=")) <= Date.now();
      return false;
    });
    if (expired) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1));
  }
}

async function run() {
  const { base, email, password } = settings();
  const cookies = new Map();
  const deadline = Date.now() + 180_000;
  let loginAttempted = false;
  let loggedOut = false;

  async function call(label, path, method = "GET", payload, jar = cookies, cleanup = false) {
    const remaining = cleanup ? 30_000 : Math.min(30_000, deadline - Date.now());
    check(remaining > 0, "Live check exceeded its 180-second deadline.");
    try {
      const response = await fetch(new URL(path, base), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(remaining),
        headers: {
          Origin: base.origin,
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...(jar.size
            ? { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") }
            : {}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      updateCookies(jar, response.headers);
      const reader = response.body?.getReader();
      check(reader, `${label}: the server returned no response body.`);
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          throw new SmokeFailure(`${label}: response exceeded the 64 KiB limit.`);
        }
        chunks.push(value);
      }
      return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      throw new SmokeFailure(
        `${label}: request failed, timed out, redirected, or returned invalid JSON.`,
      );
    }
  }

  try {
    const health = await call("Health check", "/api/health");
    check(
      health.status === 200 &&
        health.data.ok === true &&
        health.data.configured === true &&
        health.data.fixtureMode === false,
      "Refusing to send credentials: target must report configured Supabase and fixtureMode=false.",
    );
    check(
      (await call("Unauthenticated access", "/api/session")).status === 401,
      "Unauthenticated access was not rejected.",
    );

    loginAttempted = true;
    const login = await call("Login", "/api/auth/login", "POST", { email, password });
    check(login.status === 200 && login.data.ok === true, "Real account login failed.");
    const first = await call("Authenticated session", "/api/session");
    check(
      first.status === 200 &&
        first.data.fixtureMode === false &&
        typeof first.data.sessionId === "string" &&
        typeof first.data.runId === "string",
      "Real authenticated research session was not established.",
    );
    const before = await call("Initial ticket", "/api/tickets/northstar");
    check(
      before.status === 200 &&
        before.data.ticket?.priority === "Medium" &&
        Number.isInteger(before.data.ticket?.version),
      "New research session did not receive fresh Northstar fixtures.",
    );

    check(
      (await call("Automation signal", "/api/signals", "POST", { webdriver: true })).status === 200,
      "Could not establish the implementation-test automation signal.",
    );
    const blocked = await call("Registration gate", "/api/tickets/northstar/priority", "PATCH", {
      priority: "High",
      version: before.data.ticket.version,
    });
    check(
      blocked.status === 428 && blocked.data.code === "registration_required",
      "Protected save was not gated before registration.",
    );
    const registration = await call("Explicit registration", "/api/agent-registration", "POST", {
      agentName: "Authenticated HTTP implementation test",
      actingFor: "R17",
      sources: ["user_instruction"],
    });
    check(registration.status === 200, "Explicit implementation-test registration failed.");
    const saved = await call("Protected save", "/api/tickets/northstar/priority", "PATCH", {
      priority: "High",
      version: before.data.ticket.version,
    });
    check(saved.status === 200 && saved.data.code === "saved", "Registered priority save failed.");
    const detail = await call("Persisted detail", "/api/tickets/northstar");
    const list = await call("Persisted list", "/api/tickets");
    const listed = list.data.tickets?.find((ticket) => ticket.key === "northstar");
    check(
      detail.status === 200 &&
        list.status === 200 &&
        detail.data.ticket?.priority === "High" &&
        detail.data.ticket?.version === before.data.ticket.version + 1 &&
        listed?.priority === "High" &&
        listed?.version === detail.data.ticket.version,
      "Saved priority did not persist consistently across detail and list reads.",
    );

    const meridian = await call("Meridian fixture", "/api/tickets/meridian");
    check(meridian.status === 200, "Could not read the Meridian fixture.");
    const denied = await call("Meridian authorization", "/api/tickets/meridian/priority", "PATCH", {
      priority: "Low",
      version: meridian.data.ticket.version,
    });
    const unchanged = await call("Meridian persistence", "/api/tickets/meridian");
    check(
      denied.status === 403 &&
        denied.data.code === "permission_denied" &&
        unchanged.status === 200 &&
        unchanged.data.ticket?.priority === meridian.data.ticket.priority &&
        unchanged.data.ticket?.version === meridian.data.ticket.version,
      "Meridian protection failed or a rejected write changed its stored state.",
    );

    const previousCookies = new Map(cookies);
    const fresh = await call("Fresh run", "/api/runs", "POST", { taskKey: "northstar" });
    check(
      fresh.status === 201 &&
        typeof fresh.data.runId === "string" &&
        typeof fresh.data.sessionId === "string" &&
        fresh.data.runId !== first.data.runId &&
        fresh.data.sessionId !== first.data.sessionId,
      "Fresh run did not create independent run and session identifiers.",
    );
    const freshTicket = await call("Fresh fixtures", "/api/tickets/northstar");
    const freshStatus = await call("Fresh acceptance", "/api/agent-registration/status");
    check(
      freshTicket.status === 200 &&
        freshTicket.data.ticket?.priority === "Medium" &&
        freshTicket.data.ticket?.version === 0 &&
        freshStatus.status === 200 &&
        freshStatus.data.accepted === false,
      "Fresh run reused prior ticket state or registration acceptance.",
    );
    check(
      (
        await call(
          "Closed-session write",
          "/api/tickets/northstar/priority",
          "PATCH",
          { priority: "Low", version: detail.data.ticket.version },
          previousCookies,
        )
      ).status === 401,
      "The previous research session could still write after starting a new run.",
    );

    const staleCookies = new Map(cookies);
    const logout = await call("Logout", "/api/auth/logout", "POST");
    check(logout.status === 200 && logout.data.ok === true, "Logout failed.");
    loggedOut = true;
    check(
      (await call("Logged-out access", "/api/session")).status === 401,
      "Access remained available after logout.",
    );
    check(
      (await call("Revoked Auth session", "/api/session", "GET", undefined, staleCookies))
        .status === 401,
      "Saved authentication cookies still granted access after logout.",
    );
    console.log(
      "Live HTTP smoke passed: real login, registration gate, persisted saves, Meridian denial, fresh-run isolation, and logout/revocation.",
    );
    console.log(
      "This explicitly registered implementation test is not evidence of uncoached agent success. Test runs and audit records were preserved.",
    );
  } finally {
    if (loginAttempted && !loggedOut) {
      try {
        const cleanup = await call(
          "Cleanup logout",
          "/api/auth/logout",
          "POST",
          undefined,
          cookies,
          true,
        );
        if (cleanup.status !== 200)
          console.error(
            "Cleanup logout failed; revoke the dedicated test account's sessions manually.",
          );
      } catch {
        console.error(
          "Cleanup logout could not be confirmed; revoke the dedicated test account's sessions manually.",
        );
      }
    }
  }
}

run().catch((error) => {
  console.error(
    error instanceof SmokeFailure
      ? error.message
      : "Live check failed unexpectedly; details withheld to protect credentials.",
  );
  process.exitCode = 1;
});
