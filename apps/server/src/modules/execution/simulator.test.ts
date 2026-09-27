import { describe, expect, it } from "vitest";
import { SyntheticToken } from "../../test/synthetic.js";
import type { MarketTrade } from "../../domain/market.js";
import {
  DEFAULT_EXECUTION,
  HistoricalMarketView,
  estimateRoundTripCosts,
  simulateEntry,
  simulateExit,
  stateFromTrade,
  toStateTrade,
  tradeResult,
  type EntryFill,
  type ExitFill,
} from "./simulator.js";

const T0 = 1_800_000_000_000;

function viewFor(tok: SyntheticToken, trades: MarketTrade[]): HistoricalMarketView {
  const v = new HistoricalMarketView();
  v.set(tok.mint, trades.map(toStateTrade));
  return v;
}

describe("execution simulator", () => {
  it("round trip without price movement loses exactly the modelled costs", () => {
    const tok = new SyntheticToken("SimA", "c", T0);
    const trades = [tok.buy("x", 2_000_000_000n, T0 + 1000)!.data as MarketTrade];
    const view = viewFor(tok, trades);
    const e = simulateEntry(view, tok.mint, T0 + 2000, 0.01, DEFAULT_EXECUTION) as EntryFill;
    expect(e.ok).toBe(true);
    expect(e.execTs).toBe(T0 + 3500);
    expect(e.effectivePrice).toBeGreaterThan(e.spotPrice);
    const x = simulateExit(view, tok.mint, e.tokens, T0 + 10_000, DEFAULT_EXECUTION) as ExitFill;
    expect(x.ok).toBe(true);
    const r = tradeResult(e, x);
    expect(r.netPnlSol).toBeLessThan(0);
    // identity: gross = net + total costs
    expect(r.grossPnlSol).toBeCloseTo(r.netPnlSol + r.costs.totalSol, 12);
    // no price movement → gross (pure market move) ≈ 0
    expect(Math.abs(r.grossPnlSol)).toBeLessThan(0.0001);
    // cost components are all non-negative and rent is refunded
    for (const v of Object.values(r.costs)) expect(v).toBeGreaterThanOrEqual(0);
    expect(r.costs.rentRefundSol).toBeCloseTo(r.costs.rentSol, 12);
    // 0.01 SOL position: fees+priority+mev dominate → loss of a few percent
    expect(r.netReturn).toBeLessThan(-0.03);
    expect(r.netReturn).toBeGreaterThan(-0.2);
  });

  it("profits from a real price move are reduced by costs", () => {
    const tok = new SyntheticToken("SimB", "c", T0);
    const t1 = tok.buy("x", 1_000_000_000n, T0 + 1000)!.data as MarketTrade;
    const t2 = tok.buy("whale", 20_000_000_000n, T0 + 20_000)!.data as MarketTrade; // price jumps
    const view = viewFor(tok, [t1, t2]);
    const e = simulateEntry(view, tok.mint, T0 + 2000, 0.01, DEFAULT_EXECUTION) as EntryFill;
    const x = simulateExit(view, tok.mint, e.tokens, T0 + 30_000, DEFAULT_EXECUTION) as ExitFill;
    const r = tradeResult(e, x);
    expect(x.spotPrice).toBeGreaterThan(e.spotPrice * 1.5);
    expect(r.netPnlSol).toBeGreaterThan(0);
    expect(r.grossPnlSol).toBeGreaterThan(r.netPnlSol);
  });

  it("uses the state AFTER the execution delay (no look-ahead, no stale fills)", () => {
    const tok = new SyntheticToken("SimC", "c", T0);
    const t1 = tok.buy("x", 1_000_000_000n, T0 + 1000)!.data as MarketTrade;
    const t2 = tok.buy("y", 10_000_000_000n, T0 + 2500)!.data as MarketTrade; // within the delay window
    const view = viewFor(tok, [t1, t2]);
    const e = simulateEntry(view, tok.mint, T0 + 2000, 0.01, DEFAULT_EXECUTION) as EntryFill;
    expect(e.spotPrice).toBeCloseTo(t2.priceSol, 15);
    // a decision before any trade exists cannot be filled
    expect(simulateEntry(view, tok.mint, T0 - 5000, 0.01, DEFAULT_EXECUTION).ok).toBe(false);
  });

  it("failed transactions cost fees and produce no position", () => {
    const tok = new SyntheticToken("SimD", "c", T0);
    const view = viewFor(tok, [tok.buy("x", 1_000_000_000n, T0)!.data as MarketTrade]);
    const f = simulateEntry(view, tok.mint, T0 + 100, 0.01, { ...DEFAULT_EXECUTION, failedTxRate: 1 }, () => 0);
    expect(f.ok).toBe(false);
    if (!f.ok) {
      expect(f.reason).toBe("tx_failed");
      expect(f.costSol).toBeCloseTo(DEFAULT_EXECUTION.priorityFeeSol + 0.000005, 12);
    }
  });

  it("exit retries after failures cost extra fees", () => {
    const tok = new SyntheticToken("SimE", "c", T0);
    const view = viewFor(tok, [tok.buy("x", 1_000_000_000n, T0)!.data as MarketTrade]);
    let calls = 0;
    const rnd = () => (calls++ < 2 ? 0 : 0.99); // fail twice, then succeed
    const x = simulateExit(view, tok.mint, 1000, T0 + 100, DEFAULT_EXECUTION, rnd) as ExitFill;
    expect(x.ok).toBe(true);
    expect(x.retries).toBe(2);
    expect(x.priorityFeeSol).toBeCloseTo(3 * DEFAULT_EXECUTION.priorityFeeSol, 12);
  });

  it("completed curves are not tradable until the pool trades", () => {
    const tok = new SyntheticToken("SimF", "c", T0);
    const tr = tok.buy("x", 1_000_000_000n, T0)!.data as MarketTrade;
    const completed = { ...toStateTrade(tr), realTokenReserves: 0n };
    const view = new HistoricalMarketView();
    view.set(tok.mint, [completed]);
    expect(view.stateAt(tok.mint, T0 + 1)?.tradable).toBe(false);
    expect(simulateEntry(view, tok.mint, T0 + 1, 0.01, DEFAULT_EXECUTION).ok).toBe(false);
  });

  it("estimates round-trip costs and break-even move before trading", () => {
    const tok = new SyntheticToken("SimG", "c", T0);
    const s = stateFromTrade(toStateTrade(tok.buy("x", 3_000_000_000n, T0)!.data as MarketTrade));
    const est = estimateRoundTripCosts(s, 0.01, DEFAULT_EXECUTION)!;
    expect(est.totalCostSol).toBeGreaterThan(0);
    expect(est.breakEvenMove).toBeGreaterThan(0.03);
    expect(est.entryImpact).toBeGreaterThan(0);
  });
});
