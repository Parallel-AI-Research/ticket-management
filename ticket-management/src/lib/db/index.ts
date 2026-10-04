import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { databaseTls } from "./tls";
export type Database = PostgresJsDatabase<typeof schema>;
const globalDb = globalThis as unknown as { researchDb?: Promise<Database> };
export function isFixtureMode() {
  return process.env.NODE_ENV === "development" && process.env.LOCAL_FIXTURE_MODE === "true";
}
export async function getDb(): Promise<Database> {
  if (!globalDb.researchDb)
    globalDb.researchDb = connect().catch((error) => {
      globalDb.researchDb = undefined;
      throw error;
    });
  return globalDb.researchDb;
}
async function connect(): Promise<Database> {
  if (isFixtureMode()) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: pgliteDrizzle } = await import("drizzle-orm/pglite");
    const { readFile, mkdir } = await import("node:fs/promises");
    await mkdir(".local", { recursive: true });
    const client = new PGlite(".local/fixture-postgres");
    await client.exec(await readFile("scripts/schema.sql", "utf8"));
    return pgliteDrizzle(client, { schema }) as unknown as Database;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
  const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: databaseTls() });
  return drizzle(client, { schema });
}
