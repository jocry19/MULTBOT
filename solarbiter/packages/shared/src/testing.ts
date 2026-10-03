import { SOL_MINT } from "./money.js";
import type { Opportunity, Quote } from "./types.js";

/** Test factories (only imported by tests). */
export const TEST_TOKEN = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

export function makeQuote(o: Partial<Quote> = {}): Quote {
  return {
    id: `q_${Math.random().toString(36).slice(2)}`,
    kind: "firm",
    timestamp: 1_000,
    slot: 1,
    source: "raydium",
    inputMint: SOL_MINT,
    outputMint: TEST_TOKEN,
    inputAmount: 40_000_000n,
    outputAmount: 5_000_000n,
    minOutputAmount: 4_985_000n,
    slippageBps: 30,
    price: 0.125,
    priceImpact: 0.0001,
    feeRates: [0.0025],
    route: [],
    latencyMs: 100,
    ...o,
  };
}

export function makeOpportunity(o: Partial<Opportunity> = {}): Opportunity {
  const leg1 = makeQuote();
  const leg2 = makeQuote({ source: "orca", inputMint: TEST_TOKEN, outputMint: SOL_MINT, inputAmount: 5_000_000n, outputAmount: 40_150_000n, minOutputAmount: 40_060_000n, slippageBps: 22 });
  return {
    id: `opp_${Math.random().toString(36).slice(2)}`,
    timestamp: 1_000,
    slot: 1,
    mode: "paper",
    strategyType: "direct",
    strategyVersionId: null,
    route: [SOL_MINT, TEST_TOKEN, SOL_MINT],
    routeDexes: ["raydium", "orca"],
    inputMint: SOL_MINT,
    outputMint: SOL_MINT,
    tokenMint: TEST_TOKEN,
    sourceDex: "raydium",
    destinationDex: "orca",
    inputAmount: 40_000_000n,
    outputAmount: 40_150_000n,
    sizeEur: 4.8,
    solEur: 120,
    grossProfit: 150_000n,
    grossProfitPercent: 0.375,
    dexFees: 200_000n,
    networkFee: 5_000n,
    priorityFee: 10_000n,
    jitoTip: 10_000n,
    priceImpact: 0.0002,
    expectedSlippage: 8_000n,
    executionProbability: 0.8,
    expectedFailureCost: 0n,
    safetyBuffer: 40_000n,
    expectedNetProfit: 60_000n,
    expectedNetProfitPercent: 0.15,
    expectedNetProfitEur: 0.0072,
    quoteAge: 300,
    latencyEstimate: 900,
    atomic: true,
    status: "EXECUTABLE",
    rejectionReason: null,
    rejectionDetail: null,
    legs: [leg1, leg2],
    sizeLadder: [],
    costs: null,
    decisionLog: [],
    ...o,
  };
}
