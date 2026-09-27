import { silentLogger } from "../core/logger.js";
import { Database } from "../db/database.js";
import { migrate } from "../db/migrate.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://multbot:multbot@localhost:5432/multbot_test";

/** Fresh, fully migrated test database. Drops everything in the public schema first. */
export async function createTestDatabase(): Promise<Database> {
  const db = new Database(TEST_DATABASE_URL, silentLogger(), 5);
  await db.query("DROP SCHEMA IF EXISTS public CASCADE");
  await db.query("CREATE SCHEMA public");
  await migrate(db, silentLogger());
  return db;
}
