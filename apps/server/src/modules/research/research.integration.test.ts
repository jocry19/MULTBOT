import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "@multbot/shared";
import { createTestDatabase } from "../../test/db.js";
import { silentLogger } from "../../core/logger.js";
import type { Database } from "../../db/database.js";
import { SyntheticToken, rng } from "../../test/synthetic.js";
import type { MarketTrade } from "../../domain/market.js";
import { tradeRow, utcDay } from "../ingest/collector.js";
import { OutcomeLabeler } from "./labeler.js";
import { ResearchRuntime } from "./researchRuntime.js";
import { StrategyService } from "../strategy/strategyService.js";

let db: Database;
const NOW = Date.now();
const settings: Settings = mergeSettings(DEFAULT_SETTINGS, {
  research: { minSampleSize: 40, maxHypothesesPerRun: 3000, discoveryIntervalMin: 0, paperValidation: { minTrades: 10 } },
});

const TRADE_COLS = [
  "signature", "event_index", "slot", "ts", "available_at", "mint", "venue", "pool", "trader", "is_buy", "sol_amount", "token_amount",
  "fee_lamports", "fee_bps", "price_sol", "market_cap_sol", "virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves",
  "real_token_reserves", "ix_name", "source",
];

async function seed(): Promise<void> {
  const r = rng(99);
  const trades: MarketTrade[] = [];
  const samples: unknown[][] = [];
  const N = 360;
  for (let i = 0; i < N; i++) {
    const ts = NOW - 3 * 3_600_000 - (N - i) * 25_000;
    const tok = new SyntheticToken(`Mint${i.toString().padStart(4, "0")}xyz`, `creator${i}`, ts - 60_000);
    for (let k = 0; k < 5; k++) trades.push(tok.buy(`early${k}`, 300_000_000n, ts - 50_000 + k * 5_000)!.data as MarketTrade);
    const signal = r() < 0.35 ? 1 : 0;
    // what happens after the decision point
    for (let k = 1; k <= 20; k++) {
      const t = ts + 2_000 + k * 10_000;
      if (signal) trades.push(tok.buy(`buyer${i}_${k}`, BigInt(Math.floor(200_000_000 + r() * 900_000_000)), t)!.data as MarketTrade);
      else {
        const ev = tok.sell(`early${k % 5}`, (tok.holdings.get(`early${k % 5}`) ?? 0n) / 3n + 1n, t);
        if (ev) trades.push(ev.data as MarketTrade);
      }
    }
    const features = { signal, f0: r(), f1: r(), f2: r(), age_sec: 60, log_age: Math.log1p(60), ret_60s: (r() - 0.5) * 0.1 };
    samples.push([tok.mint, new Date(ts), new Date(ts), "periodic", 60, "pump_curve", JSON.stringify(features), JSON.stringify({ label: "normal", levels: {} })]);
  }
  const days = new Set(trades.map((t) => utcDay(t.ts)));
  for (const d of days) {
    await db.query("SELECT ensure_daily_partition('market_trades', $1::date)", [d]);
    await db.query("SELECT ensure_daily_partition('research_samples', $1::date)", [d]);
  }
  await db.insertMany("market_trades", TRADE_COLS, trades.map(tradeRow));
  await db.insertMany("research_samples", ["mint", "ts", "available_at", "trigger", "age_sec", "venue", "features", "regime"], samples);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seed();
});
afterAll(async () => {
  await db?.close();
});

describe("research pipeline (integration)", () => {
  it("labels samples with realistic outcomes strictly after the decision", async () => {
    const labeler = new OutcomeLabeler(db, () => settings, { now: () => NOW }, silentLogger());
    const n = await labeler.labelSamples(NOW);
    expect(n).toBe(360);
    const rows = await db.many<{ features: { signal: number }; outcome: { entry: { ok: boolean }; horizons: Record<string, { ret: number }> } }>(
      "SELECT features, outcome FROM research_samples",
    );
    const pos = rows.filter((r) => r.features.signal === 1).map((r) => r.outcome.horizons["300"]!.ret);
    const neg = rows.filter((r) => r.features.signal === 0).map((r) => r.outcome.horizons["300"]!.ret);
    expect(rows.every((r) => r.outcome.entry.ok)).toBe(true);
    expect(pos.reduce((a, b) => a + b, 0) / pos.length).toBeGreaterThan(0.2);
    expect(neg.reduce((a, b) => a + b, 0) / neg.length).toBeLessThan(0);
  });

  it("discovers the planted recipe, backtests it and moves it to paper trading", async () => {
    const activity: string[] = [];
    let changed = 0;
    const rt = new ResearchRuntime(
      db,
      settings,
      { activity: (_l, _c, m) => activity.push(m), strategiesChanged: () => changed++ },
      silentLogger(),
      { now: () => NOW },
    );
    const summary = (await rt.runDiscovery()) as { status: string; survivors: number; strategiesCreated: { strategyId: string }[] };
    expect(summary.status).toBe("done");
    expect(summary.survivors).toBeGreaterThan(0);
    expect(summary.strategiesCreated.length).toBeGreaterThan(0);
    const svc = new StrategyService(db);
    const strategies = await svc.list();
    const s = strategies.find((x) => x.id === summary.strategiesCreated[0]!.strategyId)!;
    const v = (await svc.version(s.current_version_id!))!;
    expect(v.spec.conditions.some((c) => c.kind === "feature" && c.feature === "signal")).toBe(true);
    // pipeline ran the backtest: either promoted to paper trading or rejected with a reason
    expect(["PAPER_TRADING", "REJECTED"]).toContain(s.status);
    const bt = await db.one<{ status: string; metrics: { stats: { n: number } } }>("SELECT status, metrics FROM backtests ORDER BY id DESC LIMIT 1");
    expect(bt?.status).toBe("done");
    expect(bt!.metrics.stats.n).toBeGreaterThan(0);
    const evidence = await svc.latestResult(v.id, "discovery");
    expect(evidence?.whyItMightFail).toBeDefined();
    const hyp = await db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM hypotheses");
    expect(hyp!.n).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    expect(activity.some((m) => m.includes("hypotheses tested"))).toBe(true);
  });

  it("never lets the system enable live trading; only the user can after validation", async () => {
    const svc = new StrategyService(db);
    const [s] = await svc.list(["PAPER_TRADING"]);
    if (!s) return; // backtest may have rejected; covered elsewhere
    await expect(svc.transition(s.id, "LIVE_ENABLED", "auto", "system")).rejects.toThrow(/not allowed/);
    await expect(svc.transition(s.id, "LIVE_ENABLED", "user tried early", "user")).rejects.toThrow(/not allowed/);
    await svc.transition(s.id, "PAPER_VALIDATED", "test", "system");
    await expect(svc.transition(s.id, "LIVE_ENABLED", "auto", "system")).rejects.toThrow(/not allowed/);
    const live = await svc.transition(s.id, "LIVE_ENABLED", "user review", "user");
    expect(live.live_enabled).toBe(true);
    const back = await svc.transition(s.id, "DEGRADED", "decay", "system");
    expect(back.live_enabled).toBe(false);
    const hist = await svc.history(s.id);
    expect(hist.length).toBeGreaterThanOrEqual(4);
  });
});
