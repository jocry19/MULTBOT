import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  bps,
  lamportsToEur,
  type CostBreakdown,
  type DecisionLogLine,
  type RejectionReason,
} from "@solarbiter/shared";

/**
 * Everything that decides whether an opportunity has a real, net edge. All amounts are lamports
 * (routes start and end in SOL), rates are fractions, spreads are basis points.
 */
export interface CostInputs {
  inputLamports: bigint;
  /** Final SOL output of the chained firm quotes (already net of DEX fees and price impact). */
  quotedOutputLamports: bigint;
  /** Round-trip spread at marginal (mid) prices before any cost, bps of input. */
  midSpreadBps: number;
  /** Pool fee rates along the route (fractions). */
  feeRates: number[];
  /** Expected adverse move between quote and landing (learned spread decay × latency), bps. */
  expectedSlippageBps: number;
  /** Signatures paid for (1 for a single atomic transaction). */
  signatures: number;
  priorityFeeLamports: bigint;
  /** Jito tip: always a real cost. 0 when the transaction is not sent as a bundle. */
  jitoTipLamports: bigint;
  /** Rent for token accounts that must be created (locked and refundable, not a cost). */
  rentLockedLamports: bigint;
  /** Probability that the trade lands with the expected result. */
  executionProbability: number;
  /**
   * Cost of one failed attempt. Atomic Jito bundle: 0 (a reverting bundle is not included);
   * atomic RPC transaction: base + priority fee; non-atomic: plus the inventory risk of leg 2.
   */
  failureCostLamports: bigint;
  safetyBufferBps: number;
}

const toBig = (x: number): bigint => BigInt(Math.round(x));
const clamp01 = (p: number): number => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0);

/**
 * calculateNetProfit
 *
 *   gross          = quoted output − input                    (firm quotes: DEX fees + impact inside)
 *   netIfSuccess   = gross − expected slippage − base fee − priority fee − Jito tip
 *   expectedValue  = p × netIfSuccess − (1 − p) × failure cost
 *   usableEdge     = expectedValue − safety buffer
 *
 * DEX fees and price impact are shown separately (explained from the mid spread) but not subtracted
 * a second time — they are already contained in the quoted output.
 */
export function calculateNetProfit(i: CostInputs): CostBreakdown {
  if (i.inputLamports <= 0n) throw new Error("input must be positive");
  const input = i.inputLamports;
  const inputN = Number(input);
  const p = clamp01(i.executionProbability);

  const gross = i.quotedOutputLamports - input;
  const midGross = toBig((inputN * i.midSpreadBps) / 10_000);
  const dexFees = toBig(inputN * i.feeRates.reduce((a, f) => a + Math.max(0, f), 0));
  // what the quotes took beyond the pool fees: price impact (+ drift since the mid was read)
  const residual = midGross - dexFees - gross;
  const priceImpact = residual > 0n ? residual : 0n;

  const expectedSlippage = toBig((inputN * Math.max(0, i.expectedSlippageBps)) / 10_000);
  const baseFee = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE * Math.max(1, i.signatures));
  const netIfSuccess = gross - expectedSlippage - baseFee - i.priorityFeeLamports - i.jitoTipLamports;
  const expectedFailureCost = toBig((1 - p) * Number(i.failureCostLamports));
  const expectedValue = toBig(p * Number(netIfSuccess)) - expectedFailureCost;
  const safetyBuffer = toBig((inputN * Math.max(0, i.safetyBufferBps)) / 10_000);
  const usableEdge = expectedValue - safetyBuffer;

  return {
    inputLamports: input,
    quotedOutputLamports: i.quotedOutputLamports,
    midSpreadBps: i.midSpreadBps,
    grossProfitLamports: gross,
    grossProfitBps: bps(gross, input),
    dexFeesLamports: dexFees,
    priceImpactLamports: priceImpact,
    expectedSlippageLamports: expectedSlippage,
    baseFeeLamports: baseFee,
    priorityFeeLamports: i.priorityFeeLamports,
    jitoTipLamports: i.jitoTipLamports,
    rentLockedLamports: i.rentLockedLamports,
    executionProbability: p,
    expectedFailureCostLamports: expectedFailureCost,
    safetyBufferLamports: safetyBuffer,
    netIfSuccessLamports: netIfSuccess,
    expectedValueLamports: expectedValue,
    usableEdgeLamports: usableEdge,
    usableEdgeBps: bps(usableEdge, input),
  };
}

export interface EdgeThresholds {
  minNetProfitEur: number;
  minNetProfitPercent: number;
  minExecutionProbability: number;
  screenMinSpreadBps: number;
  maxPriceImpactBps: number;
  maxJitoTipShareOfProfit: number;
}

export interface EdgeVerdict {
  trade: boolean;
  reason: RejectionReason | null;
  detail: string | null;
  usableEdgeEur: number;
}

/**
 * NO NET EDGE = NO TRADE. Returns the first cost layer that destroys the edge, so the
 * "WHY NO TRADE?" statistics show the real cause rather than a generic "not profitable".
 */
export function judgeEdge(c: CostBreakdown, t: EdgeThresholds, solEur: number): EdgeVerdict {
  const eur = (l: bigint) => lamportsToEur(l, solEur);
  const usableEdgeEur = eur(c.usableEdgeLamports);
  const no = (reason: RejectionReason, detail: string): EdgeVerdict => ({ trade: false, reason, detail, usableEdgeEur });
  const input = c.inputLamports;
  const feeBps = bps(c.dexFeesLamports, input);
  const impactBps = bps(c.priceImpactLamports, input);

  if (c.grossProfitLamports <= 0n) {
    if (c.midSpreadBps - feeBps < t.screenMinSpreadBps / 2) return no("SPREAD_TOO_SMALL", `mid spread ${c.midSpreadBps.toFixed(1)} bps vs DEX fees ${feeBps.toFixed(1)} bps`);
    if (impactBps > 0) return no("PRICE_IMPACT_TOO_HIGH", `price impact ${impactBps.toFixed(1)} bps consumed the spread`);
    return no("FEES_TOO_HIGH", `quoted gross ${c.grossProfitBps.toFixed(1)} bps after DEX fees`);
  }
  if (impactBps > t.maxPriceImpactBps) return no("PRICE_IMPACT_TOO_HIGH", `price impact ${impactBps.toFixed(1)} bps > ${t.maxPriceImpactBps} bps`);
  const afterSlippage = c.grossProfitLamports - c.expectedSlippageLamports;
  if (afterSlippage <= 0n) return no("SLIPPAGE_TOO_HIGH", `expected slippage ${bps(c.expectedSlippageLamports, input).toFixed(1)} bps ≥ gross ${c.grossProfitBps.toFixed(1)} bps`);
  const afterNetwork = afterSlippage - c.baseFeeLamports - c.priorityFeeLamports;
  if (afterNetwork <= 0n) {
    return c.priorityFeeLamports > c.baseFeeLamports
      ? no("PRIORITY_FEE_TOO_HIGH", `priority fee ${c.priorityFeeLamports} lamports ≥ edge after slippage`)
      : no("FEES_TOO_HIGH", "network fees ≥ edge after slippage");
  }
  if (c.jitoTipLamports > 0n) {
    if (c.netIfSuccessLamports <= 0n) return no("JITO_TOO_EXPENSIVE", `Jito tip ${c.jitoTipLamports} lamports ≥ edge before tip`);
    if (Number(c.jitoTipLamports) > t.maxJitoTipShareOfProfit * Number(afterNetwork)) {
      return no("JITO_TOO_EXPENSIVE", `Jito tip is ${((100 * Number(c.jitoTipLamports)) / Number(afterNetwork)).toFixed(0)} % of the edge (max ${(t.maxJitoTipShareOfProfit * 100).toFixed(0)} %)`);
    }
  }
  if (c.executionProbability < t.minExecutionProbability) {
    return no("EXECUTION_PROBABILITY_TOO_LOW", `execution probability ${(c.executionProbability * 100).toFixed(0)} % < ${(t.minExecutionProbability * 100).toFixed(0)} %`);
  }
  if (c.usableEdgeLamports <= 0n) return no("NET_PROFIT_BELOW_THRESHOLD", `usable edge ${c.usableEdgeLamports} lamports after failure cost and safety buffer`);
  if (usableEdgeEur < t.minNetProfitEur) return no("NET_PROFIT_BELOW_THRESHOLD", `usable edge ${usableEdgeEur.toFixed(4)} € < ${t.minNetProfitEur} €`);
  if (c.usableEdgeBps / 100 < t.minNetProfitPercent) return no("NET_PROFIT_BELOW_THRESHOLD", `usable edge ${(c.usableEdgeBps / 100).toFixed(3)} % < ${t.minNetProfitPercent} %`);
  return { trade: true, reason: null, detail: null, usableEdgeEur };
}

/** Human-readable waterfall for the opportunity detail view ("why does the bot want this trade?"). */
export function decisionLog(c: CostBreakdown): DecisionLogLine[] {
  const input = c.inputLamports;
  const line = (label: string, lamports: bigint | null, b?: number): DecisionLogLine => ({ label, lamports, bps: b ?? (lamports === null ? null : bps(lamports, input)) });
  return [
    line("Mid spread (marginal prices)", null, c.midSpreadBps),
    line("DEX fees (in quote)", -c.dexFeesLamports),
    line("Price impact (in quote)", -c.priceImpactLamports),
    line("Gross profit (firm quotes)", c.grossProfitLamports),
    line("Expected slippage", -c.expectedSlippageLamports),
    line("Base fee", -c.baseFeeLamports),
    line("Priority fee", -c.priorityFeeLamports),
    line("Jito tip", -c.jitoTipLamports),
    line("Net if the trade lands", c.netIfSuccessLamports),
    line(`Execution probability ${(c.executionProbability * 100).toFixed(0)} % → expected failure cost`, -c.expectedFailureCostLamports),
    line("Expected value", c.expectedValueLamports),
    line("Safety buffer", -c.safetyBufferLamports),
    line("Usable edge", c.usableEdgeLamports),
  ];
}
