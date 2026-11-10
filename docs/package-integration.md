# Standalone package integration

The ticket app consumes `@useparallel/agent-identification` **0.8.2** from npm,
pinned to that exact version, with its integrity recorded in `package-lock.json`.
Versions up to 0.5.0 came from the collector's download URLs, which no longer exist.
No SDK source is copied into this repository.

## Try it

Sign in to the [hosted ticket app](https://ticket-management-indol-two.vercel.app/login),
open one of these workspaces, and click **New run** to start that mode:

- [Optional](https://ticket-management-indol-two.vercel.app/experiments/sdk-optional/tickets):
  visitors can edit and save without answering.
- [Required](https://ticket-management-indol-two.vercel.app/experiments/sdk-required/tickets):
  any of **AI assistant**, **Person**, or **Prefer not to say** enables editing
  after the app confirms the collector's response.

Open Northstar to see the package widget above the ticket properties. Search,
priority editing, saves, reloads, and the read-only Meridian ticket work as usual.
Switching mode requires a new run with fresh ticket fixtures. The existing
baseline and V1–V6/WebMCP experiments remain available for comparison.

For a fresh agent trial, set up the account and run first, then give only the
normal ticket task and the intended navigation constraint. Do not give the
agent this integration guide or instructions to identify itself. Implementation
smoke tests deliberately make declarations and are not uncoached agent evidence.

## Configure another installation

Register the app's exact origin with the collector using a dedicated site
ID/secret. Set these **server-only** environment variables:

```dotenv
APP_ORIGIN=https://your-ticket-app.example
AGENT_ID_API_URL=https://parallel-agent-identification.vercel.app
AGENT_ID_SITE_ID=your-ticket-app
AGENT_ID_SITE_SECRET=your-private-site-secret
```

The hosted installation uses site ID `ticket-management` and allows only
`https://ticket-management-indol-two.vercel.app`. Keep preview/local origins
and secrets separate. No database migration or additional Supabase permission
is needed for this adapter.

The React wrapper lives in `src/components/package-identification-panel.tsx`.
It loads the installed package's React export, caches a signed context for the
current session and mode, and confirms the receipt through the app. The
standalone package remains usable by other websites without this app.

## Server checks and evidence

- `POST /api/runs` records the requested `packageMode` in the server-written
  session-start event. It cannot be changed within that session.
- `POST /api/package-identification/context` issues a ten-minute context bound
  to the server-resolved research session, run, login session, and mode.
- `POST /api/package-identification/receipt` uses the package's online verifier,
  then records a safe audit event. Restoring the same collector event is
  idempotent.
- The existing ticket-save endpoint reads the persisted mode. Required saves
  need a currently valid, non-revoked receipt for that session, even when the
  browser UI is bypassed. Optional saves may omit the receipt. Permissions,
  session lifetime and ticket-version checks still apply.

New package runs use this choice policy instead of the older full-registration
policy. A package choice never fabricates the original agent declaration or
marks legacy registration accepted.

Audit events and operator exports retain mode, choice, package version, and
collector session/event IDs. Request diagnostics record arrival and completion.
Receipts, binding contexts, site secrets and login cookies are not logged or
stored in the audit trail. Research and collector records keep their existing
seven-day retention.

The package records visible **self-report**. All three answers satisfy required
mode; none proves identity or grants account permissions. Online verification
and the ticket write are separate operations, so they are not an atomic
transaction with the collector.

## Activity

The package widget records a page view each time a package workspace page
loads, once its collector session is ready, whether or not the visitor answers.

Each save in a package run is also reported to the collector as a
`ticket.priority_update` action with `reportAction()`, after the response is
sent. A save that succeeds is `confirmed`. One the app refuses, such as a
required run without a receipt or a Meridian write, is `rejected`. The report
reuses the save's audit event ID, so a retried report is recorded once, and
names the ticket key as `resourceRef`. It joins the visitor's collector session
through the same session binding as the widget's binding context. The research
session, run and login IDs never leave the app. Legacy and baseline runs report
nothing.

## Signed agents

`src/proxy.ts` passes each request that carries a Web Bot Auth signature to the
collector with `reportSignedRequest()`, using the same site ID and secret. The
collector checks it and shows the result on the product's **Signed agents**
card. Unsigned requests, and scripts, styles and images, make no call, and the
visitor's response never waits for the report.

The proxy runs on the login and ticket pages; the home page redirects to the
tickets. It reports the host from the request's `Host` header,
because the agent signs the host it asked for and Next can rewrite the URL's
host, to `localhost` in development. The collector still rejects any host that
isn't one of the site's origins.

A verified signature names the agent's operator, never the person or account it
acts for. It doesn't block, admit or change anything in the app.

## Verify

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

`scripts/package-smoke.mjs` exercises the installed package in a real browser
against an already-running app and collector. Use `TEST_BASE_URL` for the exact
app origin. A local fixture needs no login. Hosted checks need dedicated
`TEST_USER_EMAIL` / `TEST_USER_PASSWORD` values supplied privately; the smoke
check creates fresh synthetic runs and signs out afterward.

The smoke check also reads the collector's activity export to confirm that an
unanswered optional run and a declared required run each keep their page views,
declaration and saves in one collector session. It needs the app's own
`AGENT_ID_SITE_SECRET` in its environment.

```sh
AGENT_ID_SITE_SECRET=... TEST_BASE_URL=http://127.0.0.1:4311 npm run test:package
```

For a local collector, register the same exact local app origin and configure
its site ID/secret on the app. The standalone collector's development fixture
already allows `http://127.0.0.1:4311` for `demo-site`; run the fixture app on
4311 and the collector on 4310 when using that configuration. The fixture's
test-only secret must never be used in production.
