import { config } from "dotenv";
import { chromium, expect, webkit } from "@playwright/test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

class SmokeFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function settings() {
  const base = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  check(
    !base.username && !base.password && !base.search && !base.hash && base.pathname === "/",
    "TEST_BASE_URL must be an application origin without credentials, path, or query.",
  );
  check(
    base.protocol === "https:" || (local && base.protocol === "http:"),
    "Use HTTPS, except for a loopback fixture server.",
  );
  const browserName = process.env.TEST_BROWSER ?? "chromium";
  check(["chromium", "webkit"].includes(browserName), "TEST_BROWSER must be chromium or webkit.");
  return { base: base.origin, local, browserName };
}

const allowedChoices = ["ai_assistant", "person", "prefer_not_to_say"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = (value) => (typeof value === "string" && uuid.test(value) ? value : null);
const safeChoice = (value) => (allowedChoices.includes(value) ? value : null);
const timestamp = () => new Date().toISOString();

async function run() {
  const { base, local, browserName } = settings();
  const evidence = fileURLToPath(
    new URL(
      `../.local/evidence/package-integration/${timestamp().replaceAll(":", "-")}-${browserName}/`,
      import.meta.url,
    ),
  );
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await chmod(evidence, 0o700);
  const report = {
    kind: "Coached browser implementation check, not an unassisted agent trial",
    startedAt: timestamp(),
    base,
    browserName,
    fixtureMode: null,
    checks: [],
    runs: [],
    collector: [],
    acknowledgments: [],
    screenshots: [],
    status: "running",
  };
  let stage = "browser setup";
  let browser;
  let context;
  let page;
  let loginAttempted = false;
  let currentRun = null;
  const pendingEvidence = new Set();
  const legacyRequests = [];
  const declarationRequests = [];
  const receiptRequests = [];
  const pageErrors = [];
  let collectorOrigin;

  async function writeReport() {
    const path = `${evidence}/results.json`;
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await chmod(path, 0o600);
  }
  async function screenshot(name) {
    const path = `${evidence}/${name}.png`;
    await page.screenshot({
      path,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      timeout: 10_000,
    });
    await chmod(path, 0o600);
    report.screenshots.push(`${name}.png`);
  }
  async function scenario(name, operation) {
    stage = name;
    await operation();
    report.checks.push({ name, status: "passed", at: timestamp() });
    await writeReport();
    console.log(`Passed: ${name}`);
  }
  async function api(path, method = "GET", data) {
    const response = await context.request.fetch(`${base}${path}`, {
      method,
      data,
      headers: { Origin: base },
      timeout: 30_000,
      maxRedirects: 0,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SmokeFailure("Application API returned an unreadable response.");
    }
    return { status: response.status(), data: body };
  }
  function trialPath(mode, ticket = "northstar") {
    return `/experiments/sdk-${mode}/tickets${ticket ? `/${ticket}` : ""}`;
  }
  async function startRun(mode, navigate = true) {
    const result = await api("/api/runs", "POST", { taskKey: "northstar", packageMode: mode });
    check(
      result.status === 201 && safeId(result.data.sessionId) && safeId(result.data.runId),
      "A fresh package research run was not created.",
    );
    currentRun = {
      mode,
      sessionId: result.data.sessionId,
      runId: result.data.runId,
      startedAt: timestamp(),
    };
    report.runs.push(currentRun);
    if (navigate) await openTicket(mode);
    return currentRun;
  }
  async function openTicket(mode, ticket = "northstar") {
    await page.goto(`${base}${trialPath(mode, ticket)}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await expect(page.getByRole("combobox", { name: "Ticket priority" })).toBeVisible();
  }
  const priority = () => page.getByRole("combobox", { name: "Ticket priority" });
  const saveButton = () => page.getByRole("button", { name: "Save changes", exact: true });
  const widget = () => page.getByRole("region", { name: "Visitor identification", exact: true });
  async function readyWidget() {
    await expect(widget()).toBeVisible();
    await expect(widget().getByRole("button", { name: "AI assistant", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
  }
  async function selectHigh() {
    await expect(priority()).toBeEnabled();
    await priority().click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(priority()).toHaveText(/High/);
  }
  async function saveHigh() {
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/tickets/northstar/priority" &&
          response.request().method() === "PATCH",
      ),
      saveButton().click(),
    ]);
    check(saved.status() === 200, "Browser ticket save was rejected.");
    await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
    const persisted = await api("/api/tickets/northstar");
    check(
      persisted.status === 200 && persisted.data.ticket?.priority === "High",
      "Saved priority was not persisted by the ticket backend.",
    );
  }
  async function recorded(label, expectedChoice) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/package-identification/receipt" &&
          response.request().method() === "POST" &&
          response.status() === 200,
        { timeout: 30_000 },
      ),
      widget().getByRole("button", { name: label, exact: true }).click(),
    ]);
    const body = await response.json();
    check(
      body.choice === expectedChoice &&
        body.evidence === "self_reported" &&
        body.sessionId === currentRun.sessionId &&
        body.mode === currentRun.mode &&
        safeId(body.collectorSessionId) &&
        safeId(body.collectorEventId),
      "The app did not acknowledge the collector declaration for the active research run.",
    );
    await expect(widget().getByRole("status")).toHaveText(`Response recorded: ${label}.`);
    await expect(priority()).toBeEnabled();
    return {
      sessionId: body.sessionId,
      collectorSessionId: body.collectorSessionId,
      collectorEventId: body.collectorEventId,
      choice: body.choice,
    };
  }
  async function waitForRestoration(action, expected) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/package-identification/receipt" &&
          response.status() === 200,
        { timeout: 30_000 },
      ),
      action(),
    ]);
    const body = await response.json();
    check(
      body.sessionId === expected.sessionId &&
        body.collectorSessionId === expected.collectorSessionId &&
        body.collectorEventId === expected.collectorEventId &&
        body.choice === expected.choice,
      "Reload or drawer remount did not restore the original collector declaration.",
    );
    await expect(priority()).toBeEnabled();
  }

  try {
    // Use bundled full Chromium's new headless mode; the macOS headless shell can stall input.
    browser =
      browserName === "webkit"
        ? await webkit.launch()
        : await chromium.launch({ channel: "chromium" });
    context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    context.setDefaultTimeout(20_000);
    page = await context.newPage();
    page.on("pageerror", () => pageErrors.push({ at: timestamp() }));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === "/api/signals" ||
        url.pathname.startsWith("/api/agent-registration") ||
        url.pathname === "/api/events"
      )
        legacyRequests.push({ path: url.pathname, method: request.method(), at: timestamp() });
      if (url.pathname === "/v1/declarations" && request.method() === "POST")
        declarationRequests.push({ at: timestamp() });
      if (url.pathname === "/api/package-identification/receipt" && request.method() === "POST")
        receiptRequests.push({ at: timestamp() });
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      const path = url.pathname;
      if (
        ![
          "/api/package-identification/context",
          "/api/package-identification/receipt",
          "/v1/sessions",
          "/v1/sessions/current",
          "/v1/declarations",
        ].includes(path) ||
        response.request().method() === "OPTIONS"
      )
        return;
      const operation = (async () => {
        if (response.status() !== 200 && response.status() !== 201) return;
        const data = await response.json();
        if (path === "/api/package-identification/context") {
          collectorOrigin = new URL(data.apiUrl).origin;
          return;
        }
        if (path === "/api/package-identification/receipt") {
          report.acknowledgments.push({
            at: timestamp(),
            sessionId: safeId(data.sessionId),
            collectorSessionId: safeId(data.collectorSessionId),
            collectorEventId: safeId(data.collectorEventId),
            mode: ["optional", "required"].includes(data.mode) ? data.mode : null,
            choice: safeChoice(data.choice),
            evidence: data.evidence === "self_reported" ? "self_reported" : null,
          });
          return;
        }
        report.collector.push({
          at: timestamp(),
          path,
          method: response.request().method(),
          status: response.status(),
          sessionId: safeId(data.sessionId),
          eventId: safeId(data.eventId),
          choice: safeChoice(data.choice),
        });
      })().catch(() => {
        // Assertions read their own responses. Evidence collection must never dump response bodies.
      });
      pendingEvidence.add(operation);
      void operation.finally(() => pendingEvidence.delete(operation));
    });

    await scenario("health and isolated browser session", async () => {
      const health = await api("/api/health");
      check(health.status === 200 && health.data.ok === true, "Application health check failed.");
      report.fixtureMode = health.data.fixtureMode;
      if (local) {
        check(
          health.data.fixtureMode === true,
          "Loopback checks require explicit local fixture mode.",
        );
      } else {
        check(
          health.data.fixtureMode === false && health.data.configured === true,
          "Hosted checks require configured authentication and fixtureMode=false.",
        );
        const { TEST_USER_EMAIL: email, TEST_USER_PASSWORD: password } = process.env;
        check(email && password, "Hosted checks require TEST_USER_EMAIL and TEST_USER_PASSWORD.");
        loginAttempted = true;
        const login = await api("/api/auth/login", "POST", { email, password });
        check(login.status === 200 && login.data.ok === true, "Dedicated research login failed.");
      }
      const session = await api("/api/session");
      check(session.status === 200 && safeId(session.data.sessionId), "Research session failed.");
    });

    await scenario("optional: save and reload without declaring", async () => {
      const declarationsBefore = declarationRequests.length;
      const receiptsBefore = receiptRequests.length;
      await startRun("optional");
      await readyWidget();
      await selectHigh();
      await saveHigh();
      await page.reload({ waitUntil: "domcontentloaded" });
      await readyWidget();
      await expect(priority()).toHaveText(/High/);
      check(
        declarationRequests.length === declarationsBefore &&
          receiptRequests.length === receiptsBefore,
        "Optional mode unexpectedly submitted or confirmed a declaration.",
      );
      await screenshot("optional-saved-without-declaration");
    });

    let accepted;
    for (const [label, choice] of [
      ["AI assistant", "ai_assistant"],
      ["Person", "person"],
      ["Prefer not to say", "prefer_not_to_say"],
    ]) {
      await scenario(`required: ${label} is accepted and permits a persisted save`, async () => {
        await startRun("required");
        await readyWidget();
        await expect(priority()).toBeDisabled();
        await expect(saveButton()).toBeDisabled();
        const blocked = await api("/api/tickets/northstar/priority", "PATCH", {
          priority: "High",
          version: 0,
        });
        check(
          blocked.status === 428 && blocked.data.code === "identification_required",
          "Required mode did not reject a direct write without a receipt.",
        );
        if (choice === "ai_assistant") await screenshot("required-before-declaration");
        accepted = await recorded(label, choice);
        await selectHigh();
        await saveHigh();
        await screenshot(`required-${choice}-saved`);
      });
      if (choice === "ai_assistant") {
        await scenario(
          "required: reload and drawer remount restore the same declaration",
          async () => {
            await waitForRestoration(
              () => page.reload({ waitUntil: "domcontentloaded" }),
              accepted,
            );
            await expect(priority()).toHaveText(/High/);
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog")).toHaveCount(0);
            await waitForRestoration(
              () => page.getByRole("link", { name: /Northstar/ }).click(),
              accepted,
            );
            await expect(priority()).toHaveText(/High/);
          },
        );
      }
    }

    await scenario("required: new run isolates prior declaration and ticket state", async () => {
      const old = accepted;
      const fresh = await startRun("required");
      await readyWidget();
      check(fresh.sessionId !== old.sessionId, "New run reused the previous research session.");
      await expect(priority()).toBeDisabled();
      await expect(priority()).toHaveText(/Medium/);
      await expect(widget().getByRole("status")).toHaveText("Select any option to continue.");
      accepted = await recorded("AI assistant", "ai_assistant");
      check(
        accepted.collectorSessionId !== old.collectorSessionId,
        "New run reused the previous run's collector session.",
      );
    });

    await scenario("Meridian stays read-only after identification", async () => {
      await openTicket("required", "meridian");
      await expect(widget().getByRole("status")).toHaveText("Response recorded: AI assistant.");
      await expect(priority()).toBeDisabled();
      await expect(saveButton()).toBeDisabled();
      await expect(page.getByText(/Changes are restricted to the Security team/)).toBeVisible();
      const before = await api("/api/tickets/meridian");
      const denied = await api("/api/tickets/meridian/priority", "PATCH", {
        priority: "Low",
        version: before.data.ticket.version,
      });
      check(
        denied.status === 403 && denied.data.code === "permission_denied",
        "Meridian write permissions were bypassed.",
      );
      const after = await api("/api/tickets/meridian");
      check(
        after.data.ticket.priority === before.data.ticket.priority &&
          after.data.ticket.version === before.data.ticket.version,
        "Denied Meridian write changed persisted state.",
      );
    });

    await scenario(
      "wrong mode URL blocks editing; New run selects the requested mode",
      async () => {
        await openTicket("optional");
        await expect(priority()).toBeDisabled();
        await expect(page.getByText("Start a new run to use this workspace.").last()).toBeVisible();
        await expect(widget()).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByRole("button", { name: "New run", exact: true }).click();
        await page.getByRole("button", { name: "Start new run", exact: true }).click();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        const session = await api("/api/session");
        check(
          session.status === 200 &&
            session.data.packageMode === "optional" &&
            session.data.sessionId !== accepted.sessionId,
          "New run did not select the mode requested by the workspace URL.",
        );
        currentRun = {
          mode: "optional",
          sessionId: session.data.sessionId,
          runId: session.data.runId,
          startedAt: timestamp(),
        };
        report.runs.push(currentRun);
        await page.getByRole("link", { name: /Northstar/ }).click();
        await readyWidget();
        await selectHigh();
        await saveHigh();
      },
    );

    for (const mode of ["optional", "required"]) {
      await scenario(`${mode}: collector failure has the correct editing behavior`, async () => {
        check(collectorOrigin, "No real collector configuration was observed.");
        await startRun(mode, false);
        const matcher = (url) => url.origin === collectorOrigin && url.pathname.startsWith("/v1/");
        const failCollector = async (route) => {
          await route.fulfill({
            status: route.request().method() === "OPTIONS" ? 204 : 503,
            headers: {
              "Access-Control-Allow-Origin": base,
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-Site",
            },
            contentType: "application/json",
            body: route.request().method() === "OPTIONS" ? undefined : '{"error":"test_outage"}',
          });
        };
        await page.route(matcher, failCollector);
        try {
          await openTicket(mode);
          await expect(widget().getByRole("status")).toContainText(
            "Could not load identification.",
          );
          await expect(widget().getByRole("button", { name: "Retry", exact: true })).toBeVisible();
          if (mode === "optional") {
            await selectHigh();
            await saveHigh();
          } else {
            await expect(priority()).toBeDisabled();
            await expect(saveButton()).toBeDisabled();
            const blocked = await api("/api/tickets/northstar/priority", "PATCH", {
              priority: "High",
              version: 0,
            });
            check(blocked.status === 428, "Required mode opened during collector failure.");
          }
          await screenshot(`${mode}-collector-unavailable`);
        } finally {
          await page.unroute(matcher, failCollector);
        }
        await widget().getByRole("button", { name: "Retry", exact: true }).click();
        await readyWidget();
        await expect(page.getByRole("alert")).toHaveCount(0);
      });
    }

    await scenario(
      "receipt confirmation failure stays blocked and Retry confirmation recovers",
      async () => {
        await startRun("required");
        await readyWidget();
        const matcher = "**/api/package-identification/receipt";
        const failReceipt = (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"code":"identification_unavailable"}',
          });
        await page.route(matcher, failReceipt);
        try {
          await widget().getByRole("button", { name: "AI assistant", exact: true }).click();
          await expect(widget().getByRole("status")).toHaveText("Response recorded: AI assistant.");
          await expect(page.getByRole("alert")).toContainText("Your choice could not be confirmed");
          await expect(
            page.getByRole("button", { name: "Retry confirmation", exact: true }),
          ).toBeVisible();
          await expect(priority()).toBeDisabled();
          await expect(saveButton()).toBeDisabled();
          await screenshot("required-confirmation-unavailable");
        } finally {
          await page.unroute(matcher, failReceipt);
        }
        const [confirmed] = await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/package-identification/receipt" &&
              response.status() === 200,
          ),
          page.getByRole("button", { name: "Retry confirmation", exact: true }).click(),
        ]);
        const result = await confirmed.json();
        check(
          result.sessionId === currentRun.sessionId && result.choice === "ai_assistant",
          "Retry confirmation did not confirm the current collector declaration.",
        );
        await expect(page.getByRole("alert")).toHaveCount(0);
        await selectHigh();
        await saveHigh();
      },
    );

    await scenario("package routes remain independent of legacy identification", async () => {
      check(legacyRequests.length === 0, "A package page called the legacy agent gate or tracker.");
      check(
        pageErrors.length === 0,
        "A browser runtime error occurred during the integration check.",
      );
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = {
      stage,
      errorType: error instanceof Error ? error.name : "Unknown",
      actionability:
        error instanceof Error
          ? [
              ...new Set(
                error.message.match(
                  /element is not stable|element is not visible|element is outside of the viewport|intercepts pointer events|element is not enabled|element was detached|waiting for fonts to load/g,
                ) ?? [],
              ),
            ]
          : [],
      locations:
        error instanceof Error
          ? (error.stack ?? "")
              .split("\n")
              .filter((line) => line.includes("/scripts/package-smoke.mjs:"))
              .map((line) => line.trim())
          : [],
      message:
        error instanceof SmokeFailure
          ? error.message
          : "Browser assertion or operation failed; no raw response data was retained.",
    };
    if (page && !page.isClosed()) await screenshot("failure").catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([...pendingEvidence]);
    if (context && loginAttempted) {
      try {
        const logout = await api("/api/auth/logout", "POST");
        report.logoutConfirmed = logout.status === 200 && logout.data.ok === true;
      } catch {
        report.logoutConfirmed = false;
      }
      if (!report.logoutConfirmed) {
        report.status = "failed";
        process.exitCode = 1;
        console.error("Dedicated research logout could not be confirmed.");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    report.endedAt = timestamp();
    report.declarationRequestCount = declarationRequests.length;
    report.receiptConfirmationRequestCount = receiptRequests.length;
    report.legacyRequestCount = legacyRequests.length;
    report.legacyRequests = legacyRequests;
    report.browserRuntimeErrorCount = pageErrors.length;
    await writeReport();
    console.log(`Private integration evidence: ${evidence}/results.json`);
  }
  if (report.status === "passed")
    console.log(
      `Package browser smoke passed (${browserName}). These explicit choices test integration, not spontaneous agent identification.`,
    );
}

run().catch((error) => {
  console.error(
    error instanceof SmokeFailure
      ? error.message
      : "Package browser smoke failed. See the safe stage summary and screenshot in private evidence.",
  );
  process.exitCode = 1;
});
