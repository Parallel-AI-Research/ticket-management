import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function safeName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)) {
    throw new Error("Use a filename or trial name without directories, spaces, or traversal.");
  }
  return value;
}

export function appOrigin(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new Error("Use an HTTPS app origin without credentials or paths; HTTP is loopback-only.");
  }
  return url.origin;
}

// All managed paths are direct children of a checked, private directory.
export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (await realpath(directory)) !== path.resolve(directory)) {
    throw new Error("Evidence directories must be real directories, without symlinks.");
  }
  await chmod(directory, 0o700);
  return directory;
}

export async function readEvidence(directory: string, name: string) {
  const handle = await open(
    path.join(directory, safeName(name)),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) {
      throw new Error("Evidence must be a regular file no larger than 10 MiB.");
    }
    await handle.chmod(0o600);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds 10 MiB.");
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writeEvidence(directory: string, name: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds 10 MiB.");
  const handle = await open(path.join(directory, safeName(name)), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return sha256(bytes);
}
