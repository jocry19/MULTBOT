import { describe, expect, it } from "vitest";
import { MarketState } from "./marketState.js";
import { TradeTape } from "./tape.js";
import { computeFeatures } from "../features/featureEngine.js";
import { applyDerived, derivedName, parseDerivedName } from "../features/derived.js";
import { noCreatorIntel, noWalletIntel } from "../features/types.js";
import { ContextBaselines, ageBucket, contextKey } from "../anomaly/baselines.js";
import { EventEngine } from "../events/eventEngine.js";
import { RegimeEngine, computeRegimeMetrics, labelRegime, levelOf } from "../regime/regimeEngine.js";
import { WalletBook, profileFromTotals, emptyTotals } from "../wallets/walletBook.js";
import { SyntheticToken, randomFlow } from "../../test/synthetic.js";
import type { MarketEvent, MarketTrade } from "../../domain/market.js";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("TradeTape", () => {
  it("answers causal window queries and evicts old trades", () => {
    const tape = new TradeTape(60_000);
    for (let i = 0; i < 10; i++) {
      tape.push({ ts: T0 + i * 1000, sol: 1, tokens: 100, price: 1 + i, isBuy: i % 2 === 0, trader: `t${i % 3}`, slot: i });
    }
    const w = tape.window(T0 + 2000, T0 + 5000); // trades at 3s,4s,5s
    expect(w.trades).toBe(3);
    expect(w.firstPrice).toBe(3); // price at 2s (reference before the window)
    expect(w.lastPrice).toBe(6);
    expect(w.buys + w.sells).toBe(3);
    expect(tape.priceAt(T0 + 4500)).toBe(5);
    expect(tape.priceAt(T0 - 1)).toBeNull();
    // future trades are never visible
    expect(tape.window(T0, T0 + 3000).lastPrice).toBe(4);
    tape.evictBefore(T0 + 8000);
    expect(tape.length).toBe(2);
  });

  it("tolerates slightly out-of-order inserts", () => {
    const tape = new TradeTape(60_000);
    tape.push({ ts: 3, sol: 1, tokens: 1, price: 3, isBuy: true, trader: "a", slot: 3 });
    tape.push({ ts: 1, sol: 1, tokens: 1, price: 1, isBuy: true, trader: "b", slot: 1 });
    tape.push({ ts: 2, sol: 1, tokens: 1, price: 2, isBuy: true, trader: "c", slot: 2 });
    expect(tape.path(0, 10).map((p) => p.price)).toEqual([1, 2, 3]);
  });
});

function build(events: MarketEvent[]): MarketState {
  const m = new MarketState();
  for (const e of events) m.apply(e);
  return m;
}

describe("MarketState & features", () => {
  it("tracks curve state, holders and creator activity", () => {
    const tok = new SyntheticToken("MintAAA", "creator1", T0);
    const events: MarketEvent[] = [tok.createEvent()];
    events.push(tok.buy("creator1", 500_000_000n, T0 + 1000)!);
    events.push(tok.buy("alice", 1_000_000_000n, T0 + 2000)!);
    events.push(tok.buy("bob", 200_000_000n, T0 + 3000)!);
    events.push(tok.sell("creator1", tok.holdings.get("creator1")!, T0 + 4000)!);
    const m = build(events);
    const t = m.tokens.get("MintAAA")!;
    expect(t.seenFromCreation).toBe(true);
    expect(t.trades).toBe(4);
    expect(t.holderCount()).toBe(2); // creator sold out
    expect(t.creatorSoldTokens).toBeGreaterThan(0);
    expect(t.liquiditySol).toBeCloseTo(Number(tok.curve.realSolReserves) / 1e9, 9);

    const f = computeFeatures(t, m, T0 + 5000, { wallets: noWalletIntel, creators: noCreatorIntel });
    expect(f.age_sec).toBeCloseTo(5, 5);
    expect(f.trades_10s).toBe(4);
    expect(f.holders).toBe(2);
    expect(f.creator_sold).toBe(1);
    expect(f.creator_sold_frac).toBeCloseTo(1, 5);
    expect(f.unique_buyers_60s).toBe(3);
    expect(f.new_buyers_60s).toBe(3);
    expect(f.bonding_progress).toBeGreaterThan(0);
    for (const v of Object.values(f)) expect(Number.isFinite(v)).toBe(true);
  });

  it("features are causal: future trades do not change the value at an earlier time", () => {
    const tok = new SyntheticToken("MintBBB", "c2", T0);
    const early = [tok.createEvent(), ...randomFlow(tok, { start: T0, n: 50, intervalMs: 1000, pBuy: 0.7, traders: 20, seed: 1 })];
    const cut = T0 + 30_000;
    const m1 = build(early.filter((e) => e.kind !== "trade" || e.data.ts <= cut));
    const later = randomFlow(tok, { start: T0 + 60_000, n: 50, intervalMs: 500, pBuy: 0.2, traders: 20, seed: 2 });
    const m2 = build([...early, ...later]);
    const ctx = { wallets: noWalletIntel, creators: noCreatorIntel };
    const f1 = computeFeatures(m1.tokens.get("MintBBB")!, m1, cut, ctx);
    const f2 = computeFeatures(m2.tokens.get("MintBBB")!, m2, cut, ctx);
    // window/tape based features must match exactly
    for (const k of ["volume_60s", "trades_60s", "ret_30s", "unique_buyers_60s", "new_buyers_60s", "volatility_60s", "price_sol", "max_buy_sol_60s"]) {
      expect(f2[k]).toBeCloseTo(f1[k]!, 12);
    }
  });

  it("derived features round-trip through their names", () => {
    const name = derivedName("ratio", ["volume_60s__ctxz", "liquidity_sol"]);
    expect(name).toBe("d:ratio(volume_60s__ctxz,liquidity_sol)");
    const def = parseDerivedName(name)!;
    expect(def.args).toEqual(["volume_60s__ctxz", "liquidity_sol"]);
    expect(parseDerivedName("d:ratio(d:ratio(a,b),c)")).toBeNull();
    const f = applyDerived([def], { volume_60s__ctxz: 10, liquidity_sol: 5 });
    expect(f[name]).toBeCloseTo(2, 6);
    expect(applyDerived([def], { volume_60s__ctxz: 10 })[name]).toBeUndefined();
  });
});

describe("ContextBaselines", () => {
  it("scores values relative to their context", () => {
    const b = new ContextBaselines(["volume_60s"], 100);
    for (let i = 0; i < 500; i++) {
      b.observe({ volume_60s: 1 + (i % 10) * 0.1 }, contextKey(20, "pump_curve"));
      b.observe({ volume_60s: 100 + (i % 10) * 10 }, contextKey(4000, "pump_amm"));
    }
    b.refresh();
    const young = b.transform({ volume_60s: 50 }, contextKey(20, "pump_curve"));
    const old = b.transform({ volume_60s: 50 }, contextKey(4000, "pump_amm"));
    // 50 SOL is huge for a 20s old curve token, small for an established AMM token
    expect(young.volume_60s__ctxz).toBeGreaterThan(10);
    expect(young.volume_60s__ctxpct).toBe(1);
    expect(old.volume_60s__ctxz).toBeLessThan(0);
    expect(old.volume_60s__ctxpct).toBe(0);
  });

  it("buckets ages", () => {
    expect(ageBucket(5)).toBe("<30s");
    expect(ageBucket(45)).toBe("<60s");
    expect(ageBucket(10 * 3600)).toBe("6h+");
  });

  it("snapshot/restore keeps statistics", () => {
    const b = new ContextBaselines(["x"], 100);
    for (let i = 0; i < 200; i++) b.observe({ x: i }, "c");
    b.refresh();
    const b2 = new ContextBaselines(["x"], 100);
    b2.restore(JSON.parse(JSON.stringify(b.snapshot())));
    expect(b2.transform({ x: 100 }, "c").x__ctxz).toBeCloseTo(b.transform({ x: 100 }, "c").x__ctxz!, 9);
  });
});

describe("EventEngine", () => {
  it("fires named detectors with cooldown and deterministic uids", () => {
    const tok = new SyntheticToken("MintCCC", "c3", T0);
    const m = build([tok.createEvent(), ...randomFlow(tok, { start: T0, n: 30, intervalMs: 1000, pBuy: 0.8, traders: 10, seed: 3 })]);
    const t = m.tokens.get("MintCCC")!;
    const eng = new EventEngine();
    const f = { volume_60s__ctxz: 5, volume_accel_60s: 3, trades_60s: 20, net_flow_60s: 2, volume_60s: 12 };
    const e1 = eng.process(t, f, T0 + 40_000);
    expect(e1.map((e) => e.type)).toContain("volume_spike");
    const spike = e1.find((e) => e.type === "volume_spike")!;
    expect(spike.direction).toBe(1);
    expect(spike.context.volume_60s).toBe(12);
    // within cooldown: no duplicate
    expect(eng.process(t, f, T0 + 50_000).map((e) => e.type)).not.toContain("volume_spike");
    // after cooldown: fires again
    expect(eng.process(t, f, T0 + 200_000).map((e) => e.type)).toContain("volume_spike");
    expect(eng.eventAges("MintCCC", T0 + 210_000).volume_spike).toBeCloseTo(10, 5);
  });

  it("emits generic anomaly and combination events", () => {
    const tok = new SyntheticToken("MintDDD", "c4", T0);
    const m = build([tok.createEvent(), tok.buy("a", 100_000_000n, T0 + 1000)!]);
    const t = m.tokens.get("MintDDD")!;
    const eng = new EventEngine();
    const out = eng.process(t, { holders__ctxz: -9, new_buyers_60s__ctxz: 4, new_buyers_60s: 8, volume_60s__ctxz: 4, volume_accel_60s: 3, trades_60s: 10 }, T0 + 5000);
    const types = out.map((e) => e.type);
    expect(types).toContain("anomaly:holders:down");
    expect(types).toContain("buyer_surge");
    expect(types).toContain("volume_spike");
    expect(types.some((x) => x.startsWith("combo:"))).toBe(true);
  });

  it("derives lifecycle events from market events", () => {
    const eng = new EventEngine();
    const tok = new SyntheticToken("MintEEE", "c5", T0);
    const ev = eng.fromMarketEvent(tok.createEvent());
    expect(ev[0]?.type).toBe("token_created");
    expect(ev[0]?.availableAt).toBeGreaterThanOrEqual(ev[0]!.ts);
  });
});

describe("RegimeEngine", () => {
  it("classifies relative to its own history", () => {
    const r = new RegimeEngine();
    const base = { trades_5m: 1000, volume_5m: 500, new_tokens_5m: 100, migrations_1h: 5, active_tokens_5m: 300, breadth: 0.5, volatility: 0.1, buy_share_5m: 0.5, median_liquidity: 5 };
    for (let i = 0; i < 200; i++) r.update({ ...base, trades_5m: 900 + (i % 200), new_tokens_5m: 90 + (i % 20), active_tokens_5m: 280 + (i % 40) }, T0 + i * 60_000);
    const hot = r.update({ ...base, trades_5m: 5000, new_tokens_5m: 500, active_tokens_5m: 2000, breadth: 0.9, buy_share_5m: 0.8 }, T0 + 300 * 60_000);
    expect(hot.levels.activity).toBe("extreme");
    expect(hot.label).toBe("extreme_activity");
    expect(levelOf(0.1)).toBe("low");
    expect(labelRegime({ activity: "normal", volatility: "high", liquidity: "normal", breadth: "normal", flow: "low" })).toBe("panic_selling");
  });

  it("computes market-wide metrics from the market state", () => {
    const tok = new SyntheticToken("MintFFF", "c6", T0);
    const m = build([tok.createEvent(), ...randomFlow(tok, { start: T0, n: 40, intervalMs: 2000, pBuy: 0.9, traders: 10, seed: 4 })]);
    const metrics = computeRegimeMetrics(m, T0 + 90_000);
    expect(metrics.new_tokens_5m).toBe(1);
    expect(metrics.active_tokens_5m).toBe(1);
    expect(metrics.trades_5m).toBeGreaterThan(0);
    expect(metrics.buy_share_5m).toBeGreaterThan(0.5);
  });
});

describe("WalletBook", () => {
  it("closes positions and computes evidence-based skill", () => {
    const book = new WalletBook();
    const tok = new SyntheticToken("MintGGG", "c7", T0);
    let ts = T0;
    // wallet 'pro' wins 12 times, 'noob' loses 12 times
    for (let i = 0; i < 12; i++) {
      const tk = new SyntheticToken(`Mint${i}`, "c", ts);
      const b1 = tk.buy("pro", 100_000_000n, ts + 1000)!.data as MarketTrade;
      book.onTrade(b1, ts, "c");
      const pump = tk.buy("whale", 5_000_000_000n, ts + 2000)!.data as MarketTrade;
      book.onTrade(pump, ts, "c");
      const nb = tk.buy("noob", 100_000_000n, ts + 3000)!.data as MarketTrade;
      book.onTrade(nb, ts, "c");
      const s1 = tk.sell("pro", tk.holdings.get("pro")!, ts + 4000)!.data as MarketTrade;
      expect(book.onTrade(s1, ts, "c")).not.toBeNull();
      const dump = tk.sell("whale", tk.holdings.get("whale")!, ts + 5000)!.data as MarketTrade;
      book.onTrade(dump, ts, "c");
      const s2 = tk.sell("noob", tk.holdings.get("noob")!, ts + 6000)!.data as MarketTrade;
      book.onTrade(s2, ts, "c");
      ts += 60_000;
    }
    const pro = book.profile("pro")!;
    const noob = book.profile("noob")!;
    expect(pro.closedPositions).toBe(12);
    expect(pro.winRate).toBe(1);
    expect(pro.skill).toBeGreaterThan(0);
    expect(noob.skill).toBe(0);
    expect(noob.meanReturn).toBeLessThan(0);
    void tok;
  });

  it("requires evidence before assigning skill", () => {
    const t = emptyTotals(0);
    t.closedPositions = 3;
    t.winningPositions = 3;
    t.sumReturn = 3;
    t.sumReturnSq = 3;
    expect(profileFromTotals(t, null).skill).toBe(0);
  });

  it("tracks creator quick dumps and flushes additive deltas", () => {
    const book = new WalletBook();
    const tk = new SyntheticToken("MintHHH", "dev", T0);
    book.onCreate(tk.createEvent().data as import("../../domain/market.js").TokenCreated);
    book.onTrade(tk.buy("dev", 1_000_000_000n, T0 + 1000)!.data as MarketTrade, T0, "dev");
    book.onTrade(tk.sell("dev", tk.holdings.get("dev")!, T0 + 60_000)!.data as MarketTrade, T0, "dev");
    expect(book.creator("dev")).toEqual({ tokensCreated: 1, tokensCompleted: 0, quickDumps: 1 });
    const deltas = book.takeWalletDeltas();
    expect(deltas.find((d) => d.address === "dev")?.delta.trades).toBe(2);
    expect(book.takeWalletDeltas()).toHaveLength(0);
    expect(book.totals("dev")?.trades).toBe(2);
  });
});

describe("wallet clustering", () => {
  it("links wallets that repeatedly buy the same tokens early", async () => {
    const { clusterWallets } = await import("../wallets/clustering.js");
    const obs = [];
    for (let m = 0; m < 5; m++) {
      obs.push({ mint: `m${m}`, wallet: "A", slot: m * 10, ts: m });
      obs.push({ mint: `m${m}`, wallet: "B", slot: m * 10, ts: m });
      obs.push({ mint: `m${m}`, wallet: "C", slot: m * 10 + 1, ts: m });
      obs.push({ mint: `m${m}`, wallet: `random${m}`, slot: m * 10 + 2, ts: m });
    }
    obs.push({ mint: "m0", wallet: "D", slot: 1, ts: 0 });
    const clusters = clusterWallets(obs, { minSharedTokens: 3, maxClusterSize: 50 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toEqual(["A", "B", "C"]);
    expect(clusters[0]!.sameSlotRate).toBeGreaterThan(0.3);
  });
});
