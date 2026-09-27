import { loadConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { Database } from "../db/database.js";
import { migrate } from "../db/migrate.js";

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
const db = new Database(config.database.url, log, 2);
try {
  const n = await migrate(db, log);
  log.info({ applied: n }, "migrations complete");
} catch (err) {
  log.fatal({ err }, "migration failed");
  process.exitCode = 1;
} finally {
  await db.close();
}
