import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, eurToLamports } from "@solarbiter/shared";
import { dynamicSafetyBufferBps } from "./buffer.js";
import { calculateNetProfit, decisionLog, judgeEdge, type CostInputs } from "./costs.js";
import { chooseOptimalSize, evaluateLadder, fitImpactModel, predictOutput } from "./sizing.js";

const SOL_EUR = 120;
const s = DEFAULT_SETTINGS;
const thresholds = {
  minNetProfitEur: s.strategy.minNetProfitEur,
  minNetProfitPercent: s.strategy.minNetProfitPercent,
  minExecutionProbability: s.strategy.minExecutionProbability,
  screenMinSpreadBps: s.strategy.screenMinSpreadBps,
  maxPriceImpactBps: s.risk.maxPriceImpactBps,
  maxJitoTipShareOfProfit: s.risk.maxJitoTipShareOfProfit,
};

const base = (o: Partial<CostInputs> = {}): CostInputs => ({
  inputLamports: 40_000_000n, // 0.04 SOL ≈ 4.8 €
  quotedOutputLamports: 40_200_000n, // +50 bps gross
  midSpreadBps: 110,
  feeRates: [0.0025, 0.003],
  expectedSlippageBps: 3,
  signatures: 1,
  priorityFeeLamports: 10_000n,
  jitoTipLamports: 10_000n,
  rentLockedLamports: 0n,
  executionProbability: 0.9,
  failureCostLamports: 0n,
  safetyBufferBps: 10,
  ...o,
});

describe("calculateNetProfit", () => {
  it("subtracts every real cost exactly once", () => {
    const c = calculateNetProfit(base());
    expect(c.grossProfitLamports).toBe(200_000n);
    expect(c.dexFeesLamports).toBe(220_000n); // 55 bps of input, informational
    expect(c.priceImpactLamports).toBe(20_000n); // 110 − 55 − 50 = 5 bps
    expect(c.expectedSlippageLamports).toBe(12_000n);
    expect(c.baseFeeLamports).toBe(5_000n);
    expect(c.netIfSuccessLamports).toBe(200_000n - 12_000n - 5_000n - 10_000n - 10_000n);
    expect(c.expectedValueLamports).toBe(BigInt(Math.round(0.9 * 163_000)));
    expect(c.safetyBufferLamports).toBe(40_000n);
    expect(c.usableEdgeLamports).toBe(c.expectedValueLamports - 40_000n);
    expect(judgeEdge(c, thresholds, SOL_EUR).trade).toBe(true);
  });

  it("EV = p × net − (1 − p) × failure cost", () => {
    const c = calculateNetProfit(base({ executionProbability: 0.6, failureCostLamports: 100_000n }));
    expect(c.expectedFailureCostLamports).toBe(40_000n);
    expect(c.expectedValueLamports).toBe(BigInt(Math.round(0.6 * Number(c.netIfSuccessLamports))) - 40_000n);
  });

  it("names the cost layer that kills the edge (WHY NO TRADE)", () => {
    const why = (o: Partial<CostInputs>) => judgeEdge(calculateNetProfit(base(o)), thresholds, SOL_EUR).reason;
    expect(why({ quotedOutputLamports: 39_990_000n, midSpreadBps: 56 })).toBe("SPREAD_TOO_SMALL");
    expect(why({ quotedOutputLamports: 39_990_000n, midSpreadBps: 200 })).toBe("PRICE_IMPACT_TOO_HIGH");
    expect(why({ expectedSlippageBps: 60 })).toBe("SLIPPAGE_TOO_HIGH");
    expect(why({ priorityFeeLamports: 200_000n })).toBe("PRIORITY_FEE_TOO_HIGH");
    expect(why({ jitoTipLamports: 190_000n })).toBe("JITO_TOO_EXPENSIVE"); // tip ≥ edge
    expect(why({ jitoTipLamports: 120_000n })).toBe("JITO_TOO_EXPENSIVE"); // > 50 % of edge
    expect(why({ executionProbability: 0.3 })).toBe("EXECUTION_PROBABILITY_TOO_LOW");
    expect(why({ safetyBufferBps: 60 })).toBe("NET_PROFIT_BELOW_THRESHOLD");
  });

  it("the Jito tip is a real cost: an edge that only exists before the tip is no trade", () => {
    const withTip = calculateNetProfit(base({ quotedOutputLamports: 40_080_000n, jitoTipLamports: 60_000n }));
    expect(withTip.netIfSuccessLamports).toBe(80_000n - 1_200n * 10n - 5_000n - 10_000n - 60_000n);
    expect(judgeEdge(withTip, thresholds, SOL_EUR).trade).toBe(false);
  });

  it("decision log adds up to the usable edge", () => {
    const c = calculateNetProfit(base());
    const log = decisionLog(c);
    expect(log.at(-1)?.lamports).toBe(c.usableEdgeLamports);
    expect(log.find((l) => l.label.startsWith("Gross"))?.lamports).toBe(200_000n);
  });
});

describe("safety buffer", () => {
  it("grows with uncertainty, staleness, unreliable routes and non-atomic execution", () => {
    const calm = dynamicSafetyBufferBps({ baseBps: 10, slippageStdBps: 0, quoteAgeMs: 0, maxQuoteAgeMs: 1500, routeReliability: 1, atomic: true, nonAtomicExtraBps: 50 });
    expect(calm.bps).toBe(10);
    const rough = dynamicSafetyBufferBps({ baseBps: 10, slippageStdBps: 4, quoteAgeMs: 750, maxQuoteAgeMs: 1500, routeReliability: 0.5, atomic: false, nonAtomicExtraBps: 50 });
    expect(rough.bps).toBe(10 + 4 + 5 + 5 + 50);
  });
});

describe("size ladder", () => {
  // constant-product-like: r(x) = 1.004 − 2e-11·x
  const truth = (x: bigint) => BigInt(Math.floor(Number(x) * (1.004 - 2e-11 * Number(x))));
  const sizes = s.strategy.tradeSizesEur;
  const costs = (inputLamports: bigint, outputLamports: bigint) =>
    calculateNetProfit(base({ inputLamports, quotedOutputLamports: outputLamports, midSpreadBps: 40, feeRates: [], expectedSlippageBps: 2, jitoTipLamports: 5_000n, priorityFeeLamports: 5_000n, safetyBufferBps: 5 }));

  it("fits the impact model from firm points and predicts other sizes", () => {
    const pts = [eurToLamports(1, SOL_EUR), eurToLamports(4, SOL_EUR)].map((x) => ({ inputLamports: x, outputLamports: truth(x) }));
    const m = fitImpactModel(pts, 1.004);
    const x = eurToLamports(2.5, SOL_EUR);
    const err = Number(predictOutput(m, x) - truth(x));
    expect(Math.abs(err)).toBeLessThan(5);
  });

  it("picks the size with the highest expected net profit — not simply the largest", () => {
    const one = [{ inputLamports: eurToLamports(2, SOL_EUR), outputLamports: truth(eurToLamports(2, SOL_EUR)) }];
    const m = fitImpactModel(one, 1.004);
    const evals = evaluateLadder(sizes, SOL_EUR, m, one, costs);
    expect(evals.filter((e) => !e.interpolated).map((e) => e.sizeEur)).toEqual([2]);
    const best = chooseOptimalSize(evals);
    expect(best).not.toBeNull();
    // fixed costs favour size, impact penalises it: optimum strictly inside the ladder
    expect(best!.sizeEur).toBeGreaterThan(0.5);
    for (const e of evals) expect(best!.costs.usableEdgeLamports >= e.costs.usableEdgeLamports).toBe(true);
  });

  it("returns null when no size has a positive usable edge (DO NOTHING)", () => {
    const flat = (x: bigint) => x; // zero spread
    const one = [{ inputLamports: eurToLamports(2, SOL_EUR), outputLamports: flat(eurToLamports(2, SOL_EUR)) }];
    const evals = evaluateLadder(sizes, SOL_EUR, fitImpactModel(one, 1), one, costs);
    expect(chooseOptimalSize(evals)).toBeNull();
  });
});
