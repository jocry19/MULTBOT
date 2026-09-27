import { silentLogger } from "@solarbiter/shared/node";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://solarbiter:solarbiter@localhost:5432/solarbiter_test";

/** Fresh, fully migrated test database (drops the public schema first). */
export async function createTestDatabase(): Promise<Database> {
  const db = new Database(TEST_DATABASE_URL, silentLogger(), 5);
  await db.query("DROP SCHEMA IF EXISTS public CASCADE");
  await db.query("CREATE SCHEMA public");
  await migrate(db, silentLogger());
  return db;
}
