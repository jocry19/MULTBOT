import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, strategySpecSchema, type StrategySpec } from "@multbot/shared";
import type { Database } from "../../db/database.js";
import { silentLogger } from "../../core/logger.js";
import { createTestDatabase } from "../../test/db.js";
import { StrategyService } from "../strategy/strategyService.js";
import { StrategyMonitor } from "../strategy/strategyMonitor.js";
import { calibratedExpectation } from "../learning/learningEngine.js";
import { seededRandom } from "../stats/stats.js";

let db: Database;
let svc: StrategyService;
let monitor: StrategyMonitor;
const messages: string[] = [];

const spec = (v: number): StrategySpec =>
  strategySpecSchema.parse({
    family: "recipe",
    universe: { venues: ["pump_curve"] },
    conditions: [{ kind: "feature", feature: "buy_ratio_5m", op: "gte", value: v }],
    entry: { cooldownSec: 300 },
    exit: { maxHoldSec: 300 },
    horizonSec: 300,
    params: { target: "h:300" },
  });

async function paperTrades(strategyId: string, versionId: string, n: number, meanSol: number, seed: number): Promise<void> {
  const r = seededRandom(seed);
  // both versions are compared on the period after the challenger started
  const since = Date.now() + 1_000;
  for (let i = 0; i < n; i++) {
    const pnl = meanSol + (r() - 0.5) * 0.004;
    await db.query(
      `INSERT INTO paper_trades (id, idempotency_key, strategy_id, strategy_version_id, mint, status, decision_ts, closed_at, position_size_sol, net_pnl_sol, net_return)
       VALUES ($1, $1, $2, $3, 'mint', 'CLOSED', $4, $4, 0.01, $5, $6)`,
      [randomUUID(), strategyId, versionId, new Date(since + i * 10_000), pnl, pnl / 0.01],
    );
  }
}

async function newStrategy(v: number): Promise<{ strategyId: string; versionId: string }> {
  const r = await svc.create({ spec: spec(v), origin: "manual", name: `test ${v}` });
  if (!r) throw new Error("create failed");
  await svc.transition(r.strategyId, "TESTING", "t", "system");
  await svc.transition(r.strategyId, "PAPER_TRADING", "t", "system");
  return r;
}

beforeAll(async () => {
  db = await createTestDatabase();
  svc = new StrategyService(db);
  monitor = new StrategyMonitor(db, svc, () => DEFAULT_SETTINGS, { activity: (_l, _c, m) => messages.push(m), strategiesChanged: () => undefined }, silentLogger());
});
afterAll(async () => {
  await db.close();
});

describe("challenger versions", () => {
  it("numbers minor and major variants and keeps them out of paper trading until the backtest passed", async () => {
    const { strategyId, versionId } = await newStrategy(0.6);
    const minor = await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.65), bump: "minor", changeSummary: "threshold", evidence: {} });
    expect(minor?.version).toBe("1.1");
    const major = await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.7), bump: "major", changeSummary: "structure", evidence: {} });
    expect(major?.version).toBe("2.0");
    expect(await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.7), bump: "minor", changeSummary: "dup", evidence: {} })).toBeNull();

    let active = await svc.activeForPaper();
    expect(active.filter((a) => a.strategy.id === strategyId).map((a) => a.version.id)).toEqual([versionId]);
    await svc.updateChallenger(minor?.versionId as string, { status: "PAPER_TRADING" });
    active = await svc.activeForPaper();
    expect(active.filter((a) => a.strategy.id === strategyId).map((a) => a.version.id).sort()).toEqual([versionId, minor?.versionId].sort());
  });

  it("promotes a clearly better challenger of a paper strategy and requires re-validation", async () => {
    const { strategyId, versionId } = await newStrategy(0.5);
    await svc.transition(strategyId, "PAPER_VALIDATED", "t", "system");
    const ch = await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.55), bump: "minor", changeSummary: "better", evidence: {} });
    await svc.updateChallenger(ch?.versionId as string, { status: "PAPER_TRADING" });
    await paperTrades(strategyId, versionId, 60, -0.0005, 1);
    await paperTrades(strategyId, ch?.versionId as string, 60, 0.001, 2);
    await monitor.evaluateChallengers();
    const s = await svc.get(strategyId);
    expect(s?.current_version_id).toBe(ch?.versionId);
    expect(s?.status).toBe("PAPER_TRADING");
    const old = await svc.version(versionId);
    const promoted = await svc.version(ch?.versionId as string);
    expect(old?.status).toBe("PAUSED");
    expect(promoted?.challenger_since).toBeNull();
    expect(promoted?.challenger_outcome).toBe("promoted");
  });

  it("never switches the version of a live-enabled strategy on its own — it only recommends", async () => {
    const { strategyId, versionId } = await newStrategy(0.4);
    await svc.transition(strategyId, "PAPER_VALIDATED", "t", "system");
    await svc.transition(strategyId, "LIVE_ENABLED", "user enabled", "user");
    const ch = await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.45), bump: "minor", changeSummary: "better", evidence: {} });
    await svc.updateChallenger(ch?.versionId as string, { status: "PAPER_TRADING" });
    await paperTrades(strategyId, versionId, 60, -0.0005, 3);
    await paperTrades(strategyId, ch?.versionId as string, 60, 0.001, 4);
    await monitor.evaluateChallengers();
    const s = await svc.get(strategyId);
    expect(s?.current_version_id).toBe(versionId);
    expect(s?.status).toBe("LIVE_ENABLED");
    expect((await svc.version(ch?.versionId as string))?.challenger_outcome).toBe("recommended");
    expect(messages.some((m) => m.includes("Review and activate it manually"))).toBe(true);
    await expect(svc.setCurrentVersion(strategyId, ch?.versionId as string, "system")).rejects.toThrow(/only be changed by the user/);
    // the user may activate it
    await svc.setCurrentVersion(strategyId, ch?.versionId as string, "user");
    expect((await svc.get(strategyId))?.current_version_id).toBe(ch?.versionId);
  });

  it("retires a challenger that is significantly worse", async () => {
    const { strategyId, versionId } = await newStrategy(0.3);
    const ch = await svc.createChallenger({ strategyId, parentVersionId: versionId, spec: spec(0.35), bump: "minor", changeSummary: "worse", evidence: {} });
    await svc.updateChallenger(ch?.versionId as string, { status: "PAPER_TRADING" });
    await paperTrades(strategyId, versionId, 60, 0.001, 5);
    await paperTrades(strategyId, ch?.versionId as string, 60, -0.001, 6);
    await monitor.evaluateChallengers();
    const v = await svc.version(ch?.versionId as string);
    expect(v?.status).toBe("REJECTED");
    expect(v?.challenger_since).toBeNull();
    expect(v?.challenger_outcome).toBe("retired");
    expect((await svc.get(strategyId))?.current_version_id).toBe(versionId);
  });

  it("calibrates expectations towards realised results", () => {
    expect(calibratedExpectation(0.05, null, 0)).toBe(0.05);
    expect(calibratedExpectation(null, -0.02, 10)).toBeNull();
    expect(calibratedExpectation(null, -0.02, 30)).toBe(-0.02);
    expect(calibratedExpectation(0.05, -0.01, 50)).toBeCloseTo(0.02, 10);
    expect(calibratedExpectation(0.05, -0.01, 950)).toBeCloseTo(-0.007, 10);
  });
});
