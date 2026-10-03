import type { Database, StateStore } from "@solarbiter/database";
import type { ControlCommand, WorkerStatus } from "@solarbiter/shared";
import { KEY_WORKER_HEARTBEAT, KEY_WORKER_STATUS, type AppConfig, type RedisBus } from "@solarbiter/shared/node";
import type { Logger } from "pino";
import type { Auth } from "./auth.js";

export interface ApiContext {
  config: AppConfig;
  db: Database;
  store: StateStore;
  bus: RedisBus;
  auth: Auth;
  log: Logger;
}

/** Worker status from Redis; a missing / stale heartbeat means the worker is OFFLINE. */
export async function workerStatus(ctx: ApiContext): Promise<{ status: WorkerStatus | null; heartbeatAgeMs: number | null; online: boolean }> {
  try {
    const [status, hb] = await Promise.all([ctx.bus.getJson<WorkerStatus>(KEY_WORKER_STATUS), ctx.bus.getJson<{ ts: number }>(KEY_WORKER_HEARTBEAT)]);
    const age = hb ? Date.now() - hb.ts : null;
    return { status, heartbeatAgeMs: age, online: age !== null && age < 15_000 };
  } catch {
    return { status: null, heartbeatAgeMs: null, online: false };
  }
}

/**
 * Control flow: the API writes the authoritative state to the database first, then tells the
 * worker to re-read it. A lost Redis message is harmless (the worker re-reads every 10 s).
 */
export async function control(ctx: ApiContext, cmd: ControlCommand, state: [string, unknown][] = [], actor = "api"): Promise<void> {
  for (const [k, v] of state) await ctx.store.setState(k, v);
  await ctx.db.query("INSERT INTO system_events (level, category, message, data) VALUES ('info', 'control', $1, $2)", [`${cmd.type} by ${actor}`, JSON.stringify(cmd)]);
  await ctx.bus.publishControl(cmd).catch((err: Error) => ctx.log.warn({ err: err.message }, "control publish failed (worker re-reads the database)"));
}
