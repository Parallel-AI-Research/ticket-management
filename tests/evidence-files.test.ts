import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appOrigin,
  privateDirectory,
  readEvidence,
  safeName,
  sha256,
  writeEvidence,
} from "../scripts/lib/evidence-files";

test("evidence export only permits secure app origins and flat managed filenames", () => {
  assert.equal(appOrigin("https://example.org"), "https://example.org");
  assert.equal(appOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  for (const value of [
    "http://example.org",
    "https://user:pass@example.org",
    "https://example.org/api",
    "https://example.org?token=x",
  ]) {
    assert.throws(() => appOrigin(value));
  }
  for (const value of ["../secret", "/tmp/file", ".", "..", "x/y", ""])
    assert.throws(() => safeName(value));
});

test("evidence files are private, immutable through the writer, and never follow symlinks", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "research-evidence-")));
  try {
    const directory = await privateDirectory(path.join(root, "trial"));
    const hash = await writeEvidence(directory, "snapshot.json", { fixture: true });
    const bytes = await readEvidence(directory, "snapshot.json");
    assert.equal(sha256(bytes), hash);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "snapshot.json"))).mode & 0o777, 0o600);
    await assert.rejects(writeEvidence(directory, "snapshot.json", {}));
    await writeFile(path.join(root, "outside"), "private");
    await symlink(path.join(root, "outside"), path.join(directory, "linked.json"));
    await assert.rejects(readEvidence(directory, "linked.json"));
    await symlink(directory, path.join(root, "alias"));
    await assert.rejects(privateDirectory(path.join(root, "alias")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
