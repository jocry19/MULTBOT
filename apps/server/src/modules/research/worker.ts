/**
 * Research worker thread entry point. Owns its own DB pool and runs the ResearchRuntime.
 * Communicates with the main thread only through structured messages (protocol.ts).
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Settings } from "@multbot/shared";
import { loadConfig } from "../../core/config.js";
import { createLogger } from "../../core/logger.js";
import { Database } from "../../db/database.js";
import type { FromWorker, ToWorker } from "./protocol.js";
import { ResearchRuntime } from "./researchRuntime.js";

if (!parentPort) throw new Error("research worker must run in a worker thread");
const port = parentPort;
const send = (m: FromWorker) => port.postMessage(m);

// registers secrets for log scrubbing in this thread as well
const config = loadConfig();
const log = createLogger({ level: config.logLevel, logDir: config.logDir }).child({ thread: "research" });
const db = new Database(config.database.url, log, 4);
const runtime = new ResearchRuntime(
  db,
  (workerData as { settings: Settings }).settings,
  {
    activity: (level, category, message, data) => send({ type: "activity", level, category, message, ...(data ? { data } : {}) }),
    strategiesChanged: () => send({ type: "strategies-changed" }),
  },
  log,
);

const healthTimer = setInterval(() => send({ type: "health", modules: runtime.healthAll() }), 5_000);

port.on("message", async (msg: ToWorker) => {
  if (msg.type === "settings") {
    runtime.updateSettings(msg.settings);
    return;
  }
  if (msg.type === "stop") {
    clearInterval(healthTimer);
    await runtime.stop().catch((err) => log.error({ err }, "research stop failed"));
    await db.close().catch(() => undefined);
    send({ type: "stopped" });
    return;
  }
  if (msg.type === "request") {
    try {
      let result: unknown;
      const p = msg.params;
      switch (msg.method) {
        case "runDiscovery":
          result = await runtime.runDiscovery();
          break;
        case "runBacktest":
          result = await runtime.backtestAndPromote(String(p.strategyId), String(p.versionId));
          break;
        case "analogues":
          result = runtime.queryAnalogues(p.features as Record<string, number>, String(p.venue), Number(p.ageSec));
          break;
        case "labelNow":
          result = await runtime.labeler.labelSamples();
          break;
        case "clusters":
          result = await runtime.clusterJob();
          break;
        case "monitorNow":
          await runtime.monitor.run();
          result = true;
          break;
        case "learnNow":
          result = await runtime.learning.run();
          break;
      }
      send({ type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      send({ type: "response", id: msg.id, ok: false, error: (err as Error).message });
    }
  }
});

try {
  await runtime.start();
  send({ type: "ready" });
} catch (err) {
  log.fatal({ err }, "research runtime failed to start");
  process.exit(1);
}
