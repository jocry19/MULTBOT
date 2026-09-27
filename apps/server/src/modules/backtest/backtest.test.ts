import { describe, expect, it } from "vitest";
import { strategySpecSchema } from "@multbot/shared";
import { SyntheticToken } from "../../test/synthetic.js";
import type { MarketTrade } from "../../domain/market.js";
import { DEFAULT_EXECUTION, HistoricalMarketView, toStateTrade } from "../execution/simulator.js";
import { runBacktest, type DecisionSample } from "./backtestEngine.js";

const T0 = 1_800_000_000_000;

const spec = strategySpecSchema.parse({
  family: "recipe",
  universe: { venues: ["pump_curve"] },
  conditions: [{ kind: "feature", feature: "signal", op: "gte", value: 1 }],
  entry: { cooldownSec: 600 },
  exit: { takeProfitPct: 0.3, stopLossPct: 0.2, maxHoldSec: 300 },
  horizonSec: 300,
});

function scenario(mint: string, move: "pump" | "dump" | "flat", start: number) {
  const tok = new SyntheticToken(mint, "c", start);
  const trades: MarketTrade[] = [tok.buy("seed", move === "dump" ? 10_000_000_000n : 3_000_000_000n, start)!.data as MarketTrade];
  for (let i = 1; i <= 30; i++) {
    const ts = start + 5_000 + i * 5_000;
    if (move === "pump") trades.push(tok.buy(`b${i}`, 800_000_000n, ts)!.data as MarketTrade);
    else if (move === "dump") {
      const held = tok.holdings.get("seed") ?? 0n;
      const ev = tok.sell("seed", held / 5n + 1n, ts);
      if (ev) trades.push(ev.data as MarketTrade);
    }
    else trades.push(tok.buy(`b${i}`, 1_000n, ts)!.data as MarketTrade);
  }
  return { tok, trades };
}

function sample(id: number, mint: string, ts: number, signal: number): DecisionSample {
  return { id, ts, mint, venue: "pump_curve", ageSec: 60, features: { signal }, regimeLabel: "normal" };
}

describe("backtest engine", () => {
  it("takes profit on pumps, stops out on dumps, ignores non-matching samples", () => {
    const view = new HistoricalMarketView();
    const a = scenario("PumpA", "pump", T0);
    const b = scenario("DumpB", "dump", T0);
    const c = scenario("FlatC", "flat", T0);
    for (const s of [a, b, c]) view.set(s.tok.mint, s.trades.map(toStateTrade));
    const samples = [sample(1, "PumpA", T0 + 2000, 1), sample(2, "DumpB", T0 + 2000, 1), sample(3, "FlatC", T0 + 2000, 0)];
    const r = runBacktest(spec, samples, view, { positionSizeSol: 0.01, maxOpenPositions: 10, exec: DEFAULT_EXECUTION, randomFailures: false, seed: "t" });
    expect(r.trades).toHaveLength(2);
    const pump = r.trades.find((t) => t.mint === "PumpA")!;
    const dump = r.trades.find((t) => t.mint === "DumpB")!;
    expect(pump.exitReason).toBe("TAKE_PROFIT");
    expect(pump.netSol).toBeGreaterThan(0);
    expect(dump.exitReason).toBe("STOP_LOSS");
    expect(dump.netSol).toBeLessThan(0);
    // gross/net identity and cost accounting
    expect(pump.result!.grossPnlSol).toBeCloseTo(pump.result!.netPnlSol + pump.result!.costs.totalSol, 12);
    expect(r.costs.priorityFeesSol).toBeGreaterThan(0);
    expect(r.equity).toHaveLength(2);
  });

  it("respects max open positions, cooldown and one position per token", () => {
    const view = new HistoricalMarketView();
    const samples: DecisionSample[] = [];
    for (let i = 0; i < 5; i++) {
      const s = scenario(`M${i}`, "flat", T0);
      view.set(s.tok.mint, s.trades.map(toStateTrade));
      samples.push(sample(i * 10 + 1, `M${i}`, T0 + 2000, 1));
      samples.push(sample(i * 10 + 2, `M${i}`, T0 + 3000, 1)); // same token while holding
    }
    const r = runBacktest(spec, samples, view, { positionSizeSol: 0.01, maxOpenPositions: 3, exec: DEFAULT_EXECUTION, randomFailures: false, seed: "t" });
    expect(r.trades).toHaveLength(3);
    expect(r.skipped.capacity).toBe(4); // M3, M4 both samples
    expect(r.skipped.holding).toBe(3); // second sample of M0..M2 while holding
  });

  it("exits on signal invalidation at a later decision point", () => {
    const inv = strategySpecSchema.parse({ ...spec, exit: { ...spec.exit, takeProfitPct: undefined, stopLossPct: undefined, invalidation: [{ kind: "feature", feature: "signal", op: "lte", value: -1 }] } });
    const view = new HistoricalMarketView();
    const s = scenario("InvD", "flat", T0);
    view.set(s.tok.mint, s.trades.map(toStateTrade));
    const r = runBacktest(inv, [sample(1, "InvD", T0 + 2000, 1), sample(2, "InvD", T0 + 60_000, -5)], view, {
      positionSizeSol: 0.01,
      maxOpenPositions: 10,
      exec: DEFAULT_EXECUTION,
      randomFailures: false,
      seed: "t",
    });
    expect(r.trades[0]!.exitReason).toBe("SIGNAL_INVALIDATED");
    expect(r.trades[0]!.exit!.decisionTs).toBe(T0 + 60_000);
  });

  it("random failed transactions are deterministic per seed and cost fees", () => {
    const view = new HistoricalMarketView();
    const samples: DecisionSample[] = [];
    for (let i = 0; i < 40; i++) {
      const s = scenario(`F${i}`, "flat", T0 + i * 1000);
      view.set(s.tok.mint, s.trades.map(toStateTrade));
      samples.push(sample(i, `F${i}`, T0 + i * 1000 + 2000, 1));
    }
    const cfg = { positionSizeSol: 0.01, maxOpenPositions: 100, exec: { ...DEFAULT_EXECUTION, failedTxRate: 0.3 }, randomFailures: true, seed: "abc" };
    const r1 = runBacktest(spec, samples, view, cfg);
    const r2 = runBacktest(spec, samples, view, cfg);
    expect(r1.failedEntries).toBeGreaterThan(0);
    expect(r1.failedEntries).toBe(r2.failedEntries);
    const failed = r1.trades.find((t) => t.exitReason === "ENTRY_FAILED")!;
    expect(failed.netSol).toBeLessThan(0);
    expect(failed.netSol).toBeGreaterThan(-0.001);
  });
});
