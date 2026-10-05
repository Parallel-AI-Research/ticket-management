import { config } from "dotenv";
import { lt } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { runs } from "../src/lib/db/schema";
config({ path: ".env.local" });
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const db = await getDb();
const deleted = await db.delete(runs).where(lt(runs.createdAt, cutoff)).returning({ id: runs.id });
console.log(
  `Removed ${deleted.length} research runs older than seven days, including their sessions, declarations, tickets, nonces, and audit events.`,
);
process.exit(0);
