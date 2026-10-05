import type { ConnectionOptions } from "node:tls";

export function databaseTls(env: NodeJS.ProcessEnv = process.env): false | ConnectionOptions {
  if (env.DATABASE_SSL === "disable") {
    if (env.NODE_ENV === "production")
      throw new Error("Database TLS cannot be disabled in production.");
    return false;
  }
  const ca = env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}
