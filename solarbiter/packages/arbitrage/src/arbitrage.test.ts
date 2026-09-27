import { describe, expect, it } from "vitest";
import { DexRegistry, type DexAdapter, type QuoteRequest } from "@solarbiter/dex";
import { DEFAULT_SETTINGS, SOL_MINT, USDC_MINT, type DexId, type PoolState, type Quote } from "@solarbiter/shared";
import { OpportunityEvaluator, type EvaluationContext, type FeeModel, type LearningPort } from "./evaluator.js";
import { CandidateQueue } from "./queue.js";
import { maxAccountsPerLeg } from "./routeQuoter.js";
import { screen, type Candidate } from "./screen.js";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const DEC: Record<string, number> = { [SOL_MINT]: 9, [USDC_MINT]: 6, [JUP]: 6, [BONK]: 5 };

const state = (pool: string, dex: DexId, mintA: string, mintB: string, priceAInB: number, feeRate = 0.0025, active = true): PoolState => ({
  pool,
  dex,
  kind: dex === "orca" ? "orca_whirlpool" : dex === "meteora" ? "meteora_dlmm" : "raydium_cpmm",
  mintA,
  mintB,
  slot: 100,
  fetchedAt: 1_000,
  priceAInB,
  feeRate,
  reserveA: null,
  reserveB: null,
  liquidity: null,
  active,
});

const opts = { minNetSpreadBps: 8, direct: true, triangular: true, maxSwaps: 3, tradable: () => true, now: 1_000 };

describe("screening", () => {
  it("finds a cross-DEX direct spread after fees and ignores same-DEX / inactive pools", () => {
    // JUP costs 0.0010 SOL on raydium, sells for 0.00102 SOL on orca (2 % mid spread)
    const states = [
      state("r1", "raydium", JUP, SOL_MINT, 0.001),
      state("o1", "orca", SOL_MINT, JUP, 1 / 0.00102, 0.0004),
      state("r2", "raydium", SOL_MINT, JUP, 1000.5),
      state("m1", "meteora", JUP, SOL_MINT, 0.0015, 0.001, false),
    ];
    const { candidates, stats } = screen(states, { ...opts, triangular: false });
    const best = candidates[0] as Candidate;
    expect(best.strategyType).toBe("direct");
    expect(best.dexes).toEqual(["raydium", "orca"]);
    expect(best.route).toEqual([SOL_MINT, JUP, SOL_MINT]);
    // raydium's better SOL→JUP pool (r2) is chosen over r1
    expect(best.hops[0]!.pool).toBe("r2");
    expect(best.midSpreadBps).toBeCloseTo((1000.5 * 0.00102 - 1) * 10_000, 6);
    expect(best.netSpreadBps).toBeCloseTo((1000.5 * 0.9975 * 0.00102 * 0.9996 - 1) * 10_000, 6);
    expect(candidates.every((c) => c.dexes[0] !== c.dexes[1])).toBe(true);
    expect(candidates.some((c) => c.dexes.includes("meteora"))).toBe(false);
    expect(stats.pairsScreened).toBe(stats.candidates + stats.belowThreshold);
  });

  it("finds triangular cycles SOL → USDC → JUP → SOL and respects the swap limit", () => {
    const states = [
      state("a", "orca", SOL_MINT, USDC_MINT, 120, 0.0004),
      state("b", "raydium", JUP, USDC_MINT, 0.1, 0.0025), // 1 JUP = 0.1 USDC
      state("c", "meteora", JUP, SOL_MINT, 0.1 / 120 * 1.01, 0.001), // JUP 1 % rich vs SOL
    ];
    const { candidates } = screen(states, { ...opts, direct: false });
    const tri = candidates.find((c) => c.route.join(">") === [SOL_MINT, USDC_MINT, JUP, SOL_MINT].join(">"));
    expect(tri).toBeDefined();
    expect(tri!.hops).toHaveLength(3);
    expect(tri!.netSpreadBps).toBeGreaterThan(50);
    expect(screen(states, { ...opts, direct: false, maxSwaps: 2 }).candidates).toHaveLength(0);
  });

  it("unsafe tokens are never routed through", () => {
    const states = [state("r1", "raydium", JUP, SOL_MINT, 0.001), state("o1", "orca", SOL_MINT, JUP, 1 / 0.00102, 0.0004)];
    expect(screen(states, { ...opts, tradable: (m) => m !== JUP }).candidates).toHaveLength(0);
  });
});

describe("candidate queue", () => {
  const cand = (key: string, spread: number, at = 1_000): Candidate => ({ key, netSpreadBps: spread, oldestStateAt: at } as Candidate);

  it("best spread first, cooldown per route, per-minute cap", () => {
    let t = 1_000;
    const q = new CandidateQueue({ maxPerMinute: 2, cooldownMs: 30_000, improvementBps: 5, maxAgeMs: 10_000 }, () => t);
    q.offer([cand("a", 10), cand("b", 30)]);
    expect(q.next()?.key).toBe("b");
    q.offer([cand("a", 10), cand("b", 31)]);
    expect(q.next()?.key).toBe("a"); // b cooling down (improved < 5 bps)
    expect(q.next()).toBeNull(); // per-minute cap
    t += 61_000;
    q.offer([cand("b", 50, t)]);
    expect(q.next()?.key).toBe("b");
    q.offer([cand("c", 50, t - 20_000)]);
    expect(q.next()).toBeNull(); // stale state
  });
});

/** Fake DEX: quotes from a fixed rate, with linear price impact. */
function fakeAdapter(id: DexId, rates: Record<string, number>, impactPerSol = 0.002, calls: QuoteRequest[] = []): DexAdapter {
  return {
    id,
    labels: [id],
    poolKinds: [],
    available: () => ({ ok: true, reason: null }),
    async getQuote(req: QuoteRequest): Promise<Quote> {
      calls.push(req);
      const rate = rates[`${req.inputMint}>${req.outputMint}`];
      if (rate === undefined) throw new Error("no route");
      const inUi = Number(req.amount) / 10 ** req.inputDecimals;
      const solSize = req.inputMint === SOL_MINT ? inUi : inUi * (rates[`${req.inputMint}>${SOL_MINT}`] ?? 0.001);
      const outUi = inUi * rate * (1 - impactPerSol * solSize);
      const out = BigInt(Math.floor(outUi * 10 ** req.outputDecimals));
      return {
        id: `q${calls.length}`,
        kind: "firm",
        timestamp: 1_000,
        slot: 101,
        source: id,
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inputAmount: req.amount,
        outputAmount: out,
        minOutputAmount: (out * BigInt(10_000 - req.slippageBps)) / 10_000n,
        slippageBps: req.slippageBps,
        price: outUi / inUi,
        priceImpact: 0,
        feeRates: [],
        route: [{ dex: id, label: id, pool: `${id}-pool`, inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out }],
        latencyMs: 50,
      };
    },
    buildSwap: () => Promise.reject(new Error("n/a")),
    getLiquidity: (p) => ({ pool: p.address, tvlUsd: 0, reserveA: null, reserveB: null, depth1pctA: null }),
    getFees: () => ({ feeRate: 0, source: "" }),
    validateRoute: (q, e) => ({ ok: q.inputMint === e.inputMint && q.outputMint === e.outputMint && q.route.length <= e.maxHops, reasons: [] }),
    discoverPools: async () => [],
    stateAccounts: () => [],
    decodeState: () => null,
  };
}

const fees: FeeModel = { computeUnits: (legs) => 150_000 * legs, priorityFeeLamports: () => 5_000n, jitoTipLamports: (g) => (g > 20_000n ? 10_000n : 1_000n), viaJito: () => true };
const learning: LearningPort = { executionProbability: () => 0.85, expectedSlippageBps: () => 2, slippageStdBps: () => 0, routeReliability: () => 1, latencyMs: () => 800 };
const evalCtx = (o: Partial<EvaluationContext> = {}): EvaluationContext => ({
  mode: "paper",
  settings: DEFAULT_SETTINGS,
  solEur: 120,
  sizeCapEur: 5,
  strategyVersionId: "v1",
  rentLockedLamports: 0n,
  poolStateAgeMs: 500,
  volatilityBps: 5,
  decimals: (m) => DEC[m],
  now: () => 1_200,
  ...o,
});

function directCandidate(buy: DexId, sell: DexId, midSpreadBps: number, netSpreadBps: number): Candidate {
  const hop = (dex: DexId, i: string, o: string) => ({ pool: `${dex}-pool`, dex, kind: "raydium_cpmm" as const, inputMint: i, outputMint: o, midRate: 1, feeRate: 0.0025, rate: 1, slot: 100, fetchedAt: 1_000 });
  const hops = [hop(buy, SOL_MINT, JUP), hop(sell, JUP, SOL_MINT)];
  hops[0]!.rate = 1 + netSpreadBps / 10_000;
  return { key: `direct:${buy}>${sell}`, strategyType: "direct", hops, route: [SOL_MINT, JUP, SOL_MINT], dexes: [buy, sell], tokenMint: JUP, midSpreadBps, netSpreadBps, feeRates: [0.0025, 0.0025], slot: 100, oldestStateAt: 1_000, detectedAt: 1_000 };
}

describe("OpportunityEvaluator", () => {
  it("probes, picks the optimal size, re-quotes it firm and approves a real edge", async () => {
    const calls: QuoteRequest[] = [];
    const registry = new DexRegistry()
      .register(fakeAdapter("raydium", { [`${SOL_MINT}>${JUP}`]: 1000 * 0.9975 }, 0.02, calls))
      .register(fakeAdapter("orca", { [`${JUP}>${SOL_MINT}`]: 0.00102 * 0.9975, [`${JUP}>${USDC_MINT}`]: 0.1 }, 0.02, calls));
    const ev = new OpportunityEvaluator(registry, fees, learning);
    const { opportunity: o, verdict, quotesUsed } = await ev.evaluate(directCandidate("raydium", "orca", 200, 150), evalCtx());
    expect(verdict.trade).toBe(true);
    expect(o.status).toBe("EXECUTABLE");
    expect(o.legs).toHaveLength(2);
    // closing leg is quoted with the first leg's expected output (token ledger sells exactly that)
    expect(o.legs[1]!.inputAmount).toBe(o.legs[0]!.outputAmount);
    expect(calls.every((c) => c.onlyDirectRoutes && c.maxAccounts === maxAccountsPerLeg(2) && c.forJitoBundle)).toBe(true);
    expect(o.sizeEur).toBeLessThanOrEqual(5);
    expect(o.sizeLadder.length).toBe(DEFAULT_SETTINGS.strategy.tradeSizesEur.length);
    expect(o.sizeLadder.find((e) => e.sizeEur === o.sizeEur)!.interpolated).toBe(false);
    expect(o.expectedNetProfit).toBe(o.costs!.usableEdgeLamports);
    expect(o.decisionLog.at(-1)!.lamports).toBe(o.expectedNetProfit);
    expect(quotesUsed).toBeGreaterThanOrEqual(2);
    // the optimum is the best usable edge on the ladder
    for (const e of o.sizeLadder) expect(o.expectedNetProfit >= e.costs.usableEdgeLamports || e.interpolated).toBe(true);
  });

  it("NO NET EDGE = NO TRADE: a spread eaten by fees becomes a recorded rejection", async () => {
    const registry = new DexRegistry()
      .register(fakeAdapter("raydium", { [`${SOL_MINT}>${JUP}`]: 1000 * 0.9975 }))
      .register(fakeAdapter("orca", { [`${JUP}>${SOL_MINT}`]: 0.001 * 1.003 * 0.9975 }));
    const { opportunity: o, verdict } = await new OpportunityEvaluator(registry, fees, learning).evaluate(directCandidate("raydium", "orca", 30, 10), evalCtx());
    expect(verdict.trade).toBe(false);
    expect(o.status).toBe("REJECTED");
    expect(o.rejectionReason).not.toBeNull();
    expect(o.legs).toHaveLength(2);
  });

  it("records route failures and size caps as rejections without inventing numbers", async () => {
    const registry = new DexRegistry().register(fakeAdapter("raydium", {})).register(fakeAdapter("orca", {}));
    const ev = new OpportunityEvaluator(registry, fees, learning);
    const r1 = await ev.evaluate(directCandidate("raydium", "orca", 200, 150), evalCtx());
    expect(r1.opportunity.rejectionReason).toBe("ROUTE_UNAVAILABLE");
    expect(r1.opportunity.expectedNetProfit).toBe(0n);
    const r2 = await ev.evaluate(directCandidate("raydium", "orca", 200, 150), evalCtx({ sizeCapEur: 0.1 }));
    expect(r2.opportunity.rejectionReason).toBe("RISK_LIMIT");
  });
});
