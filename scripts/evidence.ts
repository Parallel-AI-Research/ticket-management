import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evaluateEvidence, traceSchema } from "../src/lib/research/evidence";
import { snapshotSchema, snapshotSummarySchema } from "./lib/evidence-snapshot";
import {
  appOrigin,
  MAX_EVIDENCE_BYTES,
  privateDirectory,
  readEvidence,
  RETENTION_MS,
  safeName,
  sha256,
  writeEvidence,
} from "./lib/evidence-files";

const project = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const root = path.join(project, ".local", "evidence");
const timestamp = z.iso.datetime({ offset: true });
const retentionSchema = z
  .object({
    schemaVersion: z.literal("evidence-retention-v1"),
    createdAt: timestamp,
    dataStartedAt: timestamp,
    deleteAfter: timestamp,
  })
  .strict();
const filename = (prefix: string) =>
  `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`;

async function retention(directory: string, dataStartedAt: string) {
  const deleteAfter = new Date(Date.parse(dataStartedAt) + RETENTION_MS);
  if (deleteAfter.getTime() <= Date.now())
    throw new Error("Evidence is already beyond its seven-day retention window.");
  // Additional markers can only shorten a trial's retention when older source evidence is imported.
  await writeEvidence(directory, filename("retention"), {
    schemaVersion: "evidence-retention-v1",
    createdAt: new Date().toISOString(),
    dataStartedAt,
    deleteAfter: deleteAfter.toISOString(),
  });
}

async function getJson(url: URL, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`Operator request failed with HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Operator endpoint did not return JSON.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Operator endpoint returned no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_EVIDENCE_BYTES) {
      await reader.cancel();
      throw new Error("Operator response exceeds 10 MiB.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean" },
      trial: { type: "string" },
      origin: { type: "string" },
      session: { type: "string" },
      snapshot: { type: "string" },
      trace: { type: "string" },
      artifact: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`Usage:
  npm run evidence -- export --trial NAME --origin HTTPS_ORIGIN --session UUID
  npm run evidence -- review --trial NAME --snapshot FILE --trace FILE --artifact FILE
  npm run evidence -- prune

Files are private, ignored, and relative to .local/evidence/NAME. Export loads OPERATOR_TOKEN
from .env.local. Review requires a normalized observer trace and its reviewed, redacted
original tool artifact. Hashes establish file integrity, not authenticity or completeness.
Prune deletes expired managed trial directories; schedule it daily before measured trials.`);
    return;
  }
  if (positionals.length !== 1 || !["export", "review", "prune"].includes(positionals[0]))
    throw new Error("Choose export, review, or prune; use --help for syntax.");
  await privateDirectory(root);
  if (positionals[0] === "prune") {
    let removed = 0;
    let unmanaged = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        unmanaged++;
        continue;
      }
      const directory = path.join(root, safeName(entry.name));
      const markers = (await readdir(directory)).filter((name) =>
        /^retention-[a-zA-Z0-9.-]+\.json$/.test(name),
      );
      if (!markers.length) {
        unmanaged++;
        continue;
      }
      let expired = false;
      let invalidMarker = false;
      for (const name of markers) {
        try {
          const marker = retentionSchema.parse(
            JSON.parse((await readEvidence(directory, name)).toString("utf8")),
          );
          if (Date.parse(marker.deleteAfter) !== Date.parse(marker.dataStartedAt) + RETENTION_MS)
            throw new Error("Invalid retention marker.");
          expired ||= Date.parse(marker.deleteAfter) <= Date.now();
        } catch {
          invalidMarker = true;
        }
      }
      if (expired) {
        await rm(directory, { recursive: true });
        removed++;
      } else if (invalidMarker) {
        unmanaged++;
      }
    }
    console.log(
      `Deleted ${removed} expired evidence directories. ${unmanaged} unmanaged entries need operator review. Database cleanup is a separate data:prune command.`,
    );
    return;
  }
  if (!values.trial) throw new Error("Supply --trial NAME.");
  const directory = path.join(root, safeName(values.trial));
  if (positionals[0] === "export") {
    if (!values.origin || !values.session)
      throw new Error("Export requires --origin and --session.");
    const origin = appOrigin(values.origin);
    const sessionId = z.uuid().parse(values.session);
    config({ path: path.join(project, ".env.local"), quiet: true });
    const token = process.env.OPERATOR_TOKEN;
    if (!token || token.length < 32)
      throw new Error("Configure OPERATOR_TOKEN with at least 32 characters.");
    z.object({ configured: z.literal(true), fixtureMode: z.literal(false) }).parse(
      await getJson(new URL("/api/health", origin)),
    );
    const body = await getJson(new URL(`/api/operator/sessions/${sessionId}`, origin), token);
    const summary = snapshotSummarySchema.parse(body);
    if (summary.session.id !== sessionId)
      throw new Error("Operator response belongs to another session.");
    const now = new Date().toISOString();
    const startedAt = new Date(
      Math.min(Date.now(), ...summary.events.map((event) => new Date(event.createdAt).getTime())),
    ).toISOString();
    await privateDirectory(directory);
    await retention(directory, startedAt);
    const name = filename("snapshot");
    // Keep only validated fields, including final fixture state.
    await writeEvidence(directory, name, {
      schemaVersion: "operator-snapshot-v1",
      capturedAt: now,
      origin,
      summary,
    });
    console.log(
      `Saved .local/evidence/${values.trial}/${name}. This is server evidence only; no agent authorship or measured-trial success is established.`,
    );
    return;
  }

  // Review may not create a missing trial directory or silently fetch fresh server state.
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Export a snapshot into the trial directory first.");
  await privateDirectory(directory);
  if (!values.snapshot || !values.trace || !values.artifact)
    throw new Error("Review requires --snapshot, --trace and --artifact filenames.");
  const [snapshotBytes, traceBytes, artifactBytes] = await Promise.all([
    readEvidence(directory, values.snapshot),
    readEvidence(directory, values.trace),
    readEvidence(directory, values.artifact),
  ]);
  const snapshot = snapshotSchema.parse(JSON.parse(snapshotBytes.toString("utf8")));
  const trace = traceSchema.parse(JSON.parse(traceBytes.toString("utf8")));
  const artifactHash = sha256(artifactBytes);
  if (trace.artifact.sha256 !== artifactHash || trace.review.artifactSha256 !== artifactHash)
    throw new Error(
      "Source artifact hash does not match the trace and operator review. No report was generated.",
    );
  if (trace.window.closedAt && Date.parse(snapshot.capturedAt) < Date.parse(trace.window.closedAt))
    throw new Error(
      "Snapshot predates the trace's final boundary. Export a final server snapshot.",
    );
  await retention(directory, trace.window.startedAt);
  const report = evaluateEvidence(snapshot.summary, trace);
  const name = filename("report");
  await writeEvidence(directory, name, {
    generatedAt: new Date().toISOString(),
    trialId: values.trial,
    sourceFiles: {
      snapshot: { name: values.snapshot, sha256: sha256(snapshotBytes) },
      trace: { name: values.trace, sha256: sha256(traceBytes) },
      artifact: { name: values.artifact, sha256: artifactHash },
    },
    report,
  });
  console.log(
    `Saved .local/evidence/${values.trial}/${name}. Task: ${report.taskOutcome}; activity: ${report.activityRating}; matched ${report.coverage.matched}/${report.coverage.expected} required events. Ratings remain conditional on independent operator review.`,
  );
}

try {
  await main();
} catch (error) {
  // Never print response bodies, Zod input, credentials, or raw tool artifacts on failure.
  if (error instanceof z.ZodError)
    console.error(
      "Evidence validation failed: unsupported or incomplete input. No rating should be inferred.",
    );
  else if (error instanceof Error && error.name === "Error") console.error(error.message);
  else
    console.error(
      "Evidence operation failed. Check configuration, access, input files, and connectivity.",
    );
  process.exitCode = 1;
}
