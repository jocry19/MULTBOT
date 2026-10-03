/**
 * SOLARBITER API: REST + WebSocket for the dashboard. It never holds keys and never trades; control
 * actions are written to the database (source of truth) and signalled to the worker via Redis.
 */
import { Database, StateStore, migrate } from "@solarbiter/database";
import { RedisBus, createLogger, loadConfig } from "@solarbiter/shared/node";
import { Auth } from "./auth.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const log = createLogger({ level: config.logLevel, logDir: config.logDir }).child({ app: "api" });
const db = new Database(config.database.url, log);
await migrate(db, log);
const store = new StateStore(db);
await store.load(config.initialSettings);
const bus = new RedisBus(config.redisUrl, log);
await bus.connect();
await bus.subscribe({ events: true });
const auth = new Auth(db, config.sessionTtlHours);
const server = await buildServer({ config, db, store, bus, auth, log });
await server.listen({ host: config.http.host, port: config.http.port });
log.info({ host: config.http.host, port: config.http.port, users: await auth.userCount() }, "SOLARBITER API listening");
if ((await auth.userCount()) === 0) log.warn("no user exists yet — create one with `pnpm user:create`");

async function shutdown(): Promise<void> {
  await server.close().catch(() => undefined);
  await bus.close().catch(() => undefined);
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
