/** Apply database migrations and create the next days' partitions. */
import { Database, PARTITIONED_TABLES, ensurePartitions, migrate } from "@solarbiter/database";
import { createLogger, loadConfig } from "@solarbiter/shared/node";

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
const db = new Database(config.database.url, log);
try {
  const n = await migrate(db, log);
  const now = new Date();
  for (const t of PARTITIONED_TABLES) await ensurePartitions(db, t, now, new Date(now.getTime() + 3 * 86_400_000));
  console.log(`migrations applied: ${n}`);
} catch (err) {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
