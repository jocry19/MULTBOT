import type { FastifyInstance } from "fastify";
import { App } from "./app/app.js";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";

const config = loadConfig();
const log = createLogger({ level: config.logLevel, logDir: config.logDir });
const app = new App(config, log);
let server: FastifyInstance | null = null;

let stopping = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  const timer = setTimeout(() => {
    log.error("forced exit after shutdown timeout");
    process.exit(1);
  }, 30_000);
  timer.unref();
  try {
    await server?.close();
    await app.stop();
  } catch (err) {
    log.error({ err }, "shutdown error");
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});

try {
  await app.start();
  server = await buildServer(app);
  await server.listen({ host: config.http.host, port: config.http.port });
  log.info({ host: config.http.host, port: config.http.port, auth: Boolean(config.auth.adminPasswordHash) }, "dashboard API listening");
  if (!config.auth.adminPasswordHash) {
    log.warn("ADMIN_PASSWORD_HASH not set: dashboard is unauthenticated (bind to localhost only) and real-money actions are disabled");
  }
} catch (err) {
  log.fatal({ err }, "startup failed");
  await app.stop().catch(() => undefined);
  process.exit(1);
}
