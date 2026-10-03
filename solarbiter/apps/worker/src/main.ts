/**
 * SOLARBITER worker: market data, scanner, risk, paper/shadow/live execution, learning.
 * Starts in PAPER. Real money only after the live gate AND the user's explicit confirmation AND
 * LIVE_MODE=true in the environment.
 */
import http from "node:http";
import { createLogger, loadConfig, registry as metricsRegistry } from "@solarbiter/shared/node";
import { TradingEngine } from "./engine.js";
import { Runtime } from "./runtime.js";

const config = loadConfig();
const log = createLogger({ level: config.logLevel, logDir: config.logDir });
const rt = new Runtime(config, log.child({ app: "worker" }));
const engine = new TradingEngine(rt, log.child({ component: "engine" }));

log.info({ paperMode: config.paperMode, liveMode: config.liveMode, rpcEndpoints: config.rpc.urls.length, jupiterRps: config.jupiter.rps }, "SOLARBITER worker starting");
if (!config.liveMode) log.info("LIVE_MODE=false — real-money trading is impossible in this process");

let metricsServer: http.Server | null = null;
if (config.workerMetricsPort > 0) {
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("content-type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } else if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, botState: engine.botState() }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  metricsServer.listen(config.workerMetricsPort, "127.0.0.1");
}

await engine.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "worker stopping");
  try {
    await engine.stop();
    await rt.rpc.stop().catch(() => undefined);
    rt.wallet.dispose();
    await rt.bus.close().catch(() => undefined);
    await rt.db.close();
    metricsServer?.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
