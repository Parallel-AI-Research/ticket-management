/* AgentGate supports an agent-initiated exchange. It NEVER supplies declaration values. */
(function () {
  if (window.AgentGate) return;
  let active = false;
  let sessionInfo = null;
  async function request(path, payload) {
    const response = await fetch(
      path,
      payload === undefined
        ? { credentials: "same-origin", cache: "no-store" }
        : {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
    );
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.code || "request_failed"), { status: response.status });
    return result;
  }
  async function status() {
    const result = await request("/api/agent-registration/status");
    const wasActive = active;
    active = result.accepted;
    if (active && !wasActive) window.dispatchEvent(new Event("agentgate:accepted"));
    return result;
  }
  async function initialize() {
    active = false;
    sessionInfo = await request("/api/session");
    if (/^\/experiments\/v4\/tickets(?:\/|$)/.test(location.pathname))
      await request("/api/agent-registration/require", {});
    await request("/api/signals", { webdriver: navigator.webdriver === true });
    await status();
    return sessionInfo;
  }
  const gate = {
    policy: "/.well-known/agent-policy",
    ready: null,
    status,
    async register(declaration) {
      await gate.ready;
      const result = await request("/api/agent-registration", declaration);
      await status();
      return result;
    },
    async challenge() {
      await gate.ready;
      return request("/api/agent-registration/challenge", {});
    },
    async track(event) {
      if (!active) return;
      try {
        await request("/api/events", event);
      } catch {
        /* Server audit remains authoritative. Gaps require independent trace review. */
      }
    },
    restart() {
      gate.ready = initialize();
      return gate.ready;
    },
  };
  window.AgentGate = gate;
  if (
    location.pathname.startsWith("/tickets") ||
    /^\/experiments\/(h1|h2|v1|v2|v3|v4)\/tickets(?:\/|$)/.test(location.pathname)
  ) {
    gate.ready = initialize();
    // Keep rejection observable to the UI without an unhandled promise warning.
    gate.ready.catch(function () {});
    setInterval(function () {
      if (document.visibilityState === "visible")
        status().catch(function () {
          active = false;
        });
    }, 10000);
  } else gate.ready = Promise.resolve(null);
})();
