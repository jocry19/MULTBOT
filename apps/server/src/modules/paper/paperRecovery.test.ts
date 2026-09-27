import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@multbot/shared";
import { TypedBus } from "../../core/bus.js";
import { silentLogger } from "../../core/logger.js";
import type { Database } from "../../db/database.js";
import type { BusEvents } from "../../app/busEvents.js";
import { createTestDatabase } from "../../test/db.js";
import { ActivityLog } from "../activity/activityLog.js";
import { MarketState } from "../market/marketState.js";
import { StrategyService } from "../strategy/strategyService.js";
import { PaperEngine } from "./paperEngine.js";

/** Restart simulation for paper trading: open positions survive, half-finished entries do not linger. */

let db: Database;
let engine: PaperEngine;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await engine?.stop();
  await db.close();
});

describe("paper trading restart", () => {
  it("restores open positions and closes entries that were waiting for their fill", async () => {
    const svc = new StrategyService(db);
    const r = await svc.create({
      origin: "manual",
      name: "restart",
      spec: {
        family: "recipe",
        universe: { venues: ["pump_curve"] },
        conditions: [{ kind: "feature", feature: "signal", op: "gte", value: 1 }],
        entry: { cooldownSec: 0 },
        exit: { takeProfitPct: 0.5, stopLossPct: 0.2, maxHoldSec: 3600, invalidation: [], expectedValueExit: false },
        horizonSec: 3600,
        params: {},
      },
    });
    const { strategyId, versionId } = r as { strategyId: string; versionId: string };
    await db.query(
      `INSERT INTO paper_trades (id, idempotency_key, strategy_id, strategy_version_id, mint, status, decision_ts, opened_at, position_size_sol,
         token_qty, entry_price, gross_entry_sol, actual)
       VALUES ('p-open', 'k-open', $1, $2, 'mintA', 'OPEN', now(), now(), 0.01, 300000000000, 3.3e-8, 0.0099, '{"entrySpot": 3.2e-8, "decimals": 6}'),
              ('p-opening', 'k-opening', $1, $2, 'mintB', 'OPENING', now(), NULL, 0.01, NULL, NULL, NULL, NULL)`,
      [strategyId, versionId],
    );
    const bus = new TypedBus<BusEvents>();
    engine = new PaperEngine(db, bus, new MarketState(), svc, () => DEFAULT_SETTINGS, new ActivityLog(db, bus, silentLogger()), { now: () => Date.now() }, silentLogger());
    await engine.start();
    expect(engine.openPositions).toBe(1);
    const rows = await db.many<{ id: string; status: string; failed_reason: string | null; net_pnl_sol: number | null }>(
      "SELECT id, status, failed_reason, net_pnl_sol FROM paper_trades ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "p-open", status: "OPEN", failed_reason: null, net_pnl_sol: null },
      { id: "p-opening", status: "FAILED", failed_reason: "INTERRUPTED_BY_RESTART", net_pnl_sol: null },
    ]);
  });
});
