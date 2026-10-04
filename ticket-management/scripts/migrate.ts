import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { databaseTls } from "../src/lib/db/tls";
config({ path: ".env.local" });
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL in .env.local before applying the research schema.");
const db = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  ssl: databaseTls(),
});
try {
  await db.begin(async (tx) => {
    await tx.unsafe(await readFile("scripts/schema.sql", "utf8"));
  });
  console.log("Research schema applied. No public tables were modified.");
} finally {
  await db.end();
}
