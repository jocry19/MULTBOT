import { randomUUID } from "node:crypto";
import type { DexRegistry } from "@solarbiter/dex";
import {
  calculateNetProfit,
  chooseOptimalSize,
  decisionLog,
  dynamicSafetyBufferBps,
  evaluateLadder,
  fitImpactModel,
  judgeEdge,
  type EdgeVerdict,
} from "@solarbiter/profit-engine";
import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  bps,
  eurToLamports,
  lamportsToEur,
  type CostBreakdown,
  type ExecutionFeatures,
  type Opportunity,
  type Quote,
  type RejectionReason,
  type Settings,
  type SizeEvaluation,
  type TradeMode,
} from "@solarbiter/shared";
import { RouteQuoteError, quoteRoute, type QuotedRoute } from "./routeQuoter.js";
import type { Candidate } from "./screen.js";

/** Network cost model (priority fee oracle, Jito tip floor, learned compute units). */
export interface FeeModel {
  computeUnits(legs: number): number;
  priorityFeeLamports(expectedProfitLamports: bigint, computeUnits: number): bigint;
  /** Tip for a bundle; only called when viaJito() is true. */
  jitoTipLamports(expectedProfitLamports: bigint): bigint;
  viaJito(): boolean;
}

/** Learned estimates (with conservative priors until trained). */
export interface LearningPort {
  executionProbability(f: ExecutionFeatures): number;
  expectedSlippageBps(f: ExecutionFeatures): number;
  slippageStdBps(): number;
  routeReliability(routeKey: string): number;
  latencyMs(): number;
}

export interface EvaluationContext {
  mode: TradeMode;
  settings: Settings;
  solEur: number;
  /** Effective size cap from the risk engine (EUR). */
  sizeCapEur: number;
  strategyVersionId: string | null;
  /** Rent for token accounts the route would have to create (locked, refundable). */
  rentLockedLamports: bigint;
  poolStateAgeMs: number;
  volatilityBps: number;
  decimals: (mint: string) => number | undefined;
  now: () => number;
}

export interface EvaluationResult {
  opportunity: Opportunity;
  verdict: EdgeVerdict;
  quotesUsed: number;
}

const ladderSizes = (settings: Settings, capEur: number): number[] => [...new Set(settings.strategy.tradeSizesEur)].filter((s) => s <= capEur + 1e-9).sort((a, b) => a - b);

/**
 * Candidate → Opportunity: probe firm quotes, fit the impact model, evaluate the size ladder with the
 * full cost model, re-quote the best size firm, and judge the edge. Every outcome — including every
 * rejection — becomes an Opportunity record.
 */
export class OpportunityEvaluator {
  constructor(
    private readonly registry: DexRegistry,
    private readonly fees: FeeModel,
    private readonly learning: LearningPort,
  ) {}

  features(c: Candidate, ctx: EvaluationContext, sizeEur: number, grossBps: number, quoteAgeMs: number): ExecutionFeatures {
    return {
      strategyType: c.strategyType,
      hops: c.hops.length,
      dexes: c.dexes.join(">"),
      sizeEur,
      screenSpreadBps: c.netSpreadBps,
      grossBps,
      quoteAgeMs,
      latencyMs: this.learning.latencyMs(),
      poolStateAgeMs: ctx.poolStateAgeMs,
      volatilityBps: ctx.volatilityBps,
      hourUtc: new Date(ctx.now()).getUTCHours(),
    };
  }

  costs(c: Candidate, ctx: EvaluationContext, input: bigint, output: bigint, quoteAgeMs: number): CostBreakdown {
    const s = ctx.settings;
    const gross = output - input;
    const positive = gross > 0n ? gross : 0n;
    const cu = this.fees.computeUnits(c.hops.length);
    const priority = this.fees.priorityFeeLamports(positive, cu);
    const viaJito = this.fees.viaJito();
    const tip = viaJito ? this.fees.jitoTipLamports(positive) : 0n;
    const sizeEur = lamportsToEur(input, ctx.solEur);
    const f = this.features(c, ctx, sizeEur, bps(gross, input), quoteAgeMs);
    const buffer = dynamicSafetyBufferBps({
      baseBps: s.strategy.safetyBufferBps,
      slippageStdBps: this.learning.slippageStdBps(),
      quoteAgeMs,
      maxQuoteAgeMs: s.strategy.maxQuoteAgeMs,
      routeReliability: this.learning.routeReliability(c.key),
      atomic: true,
      nonAtomicExtraBps: s.risk.nonAtomicExtraBufferBps,
    });
    return calculateNetProfit({
      inputLamports: input,
      quotedOutputLamports: output,
      midSpreadBps: c.midSpreadBps,
      feeRates: c.feeRates,
      expectedSlippageBps: this.learning.expectedSlippageBps(f),
      signatures: 1,
      priorityFeeLamports: priority,
      jitoTipLamports: tip,
      rentLockedLamports: ctx.rentLockedLamports,
      executionProbability: this.learning.executionProbability(f),
      // a reverting bundle is not included; a reverting RPC transaction still pays its fees
      failureCostLamports: viaJito ? 0n : BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + priority,
      safetyBufferBps: buffer.bps,
    });
  }

  private thresholds(s: Settings) {
    return {
      minNetProfitEur: s.strategy.minNetProfitEur,
      minNetProfitPercent: s.strategy.minNetProfitPercent,
      minExecutionProbability: s.strategy.minExecutionProbability,
      screenMinSpreadBps: s.strategy.screenMinSpreadBps,
      maxPriceImpactBps: s.risk.maxPriceImpactBps,
      maxJitoTipShareOfProfit: s.risk.maxJitoTipShareOfProfit,
    };
  }

  async evaluate(c: Candidate, ctx: EvaluationContext): Promise<EvaluationResult> {
    const s = ctx.settings;
    const sizes = ladderSizes(s, ctx.sizeCapEur);
    let quotesUsed = 0;
    if (sizes.length === 0) return this.rejectEarly(c, ctx, "RISK_LIMIT", `no ladder size within the current cap (${ctx.sizeCapEur.toFixed(2)} €)`, quotesUsed);

    const hops = c.hops.map((h) => ({ dex: h.dex, inputMint: h.inputMint, outputMint: h.outputMint }));
    const opts = { legSlippageBps: s.strategy.legSlippageBps, forJitoBundle: this.fees.viaJito(), decimals: ctx.decimals };

    // 1) probe: firm quotes at the median ladder size
    const probeEur = sizes[Math.floor((sizes.length - 1) / 2)] as number;
    let probe: QuotedRoute;
    try {
      probe = await quoteRoute(this.registry, hops, eurToLamports(probeEur, ctx.solEur), { ...opts, priority: "ladder", maxWaitMs: 2_000 });
      quotesUsed += probe.legs.length;
    } catch (err) {
      const e = err as RouteQuoteError;
      return this.rejectEarly(c, ctx, e.code ?? "ROUTE_UNAVAILABLE", e.message, quotesUsed);
    }

    // 2) impact model + full ladder
    const midAfterFees = c.hops.reduce((a, h) => a * h.rate, 1);
    const model = fitImpactModel([{ inputLamports: probe.inputLamports, outputLamports: probe.outputLamports }], midAfterFees);
    const age = () => ctx.now() - probe.oldestQuoteAt;
    const ladder = evaluateLadder(sizes, ctx.solEur, model, [{ inputLamports: probe.inputLamports, outputLamports: probe.outputLamports }], (i, o) => this.costs(c, ctx, i, o, age()));
    const best = chooseOptimalSize(ladder);
    const probeEval = ladder.find((e) => !e.interpolated) as SizeEvaluation;

    if (!best) {
      const verdict = judgeEdge(probeEval.costs, this.thresholds(s), ctx.solEur);
      return { opportunity: this.build(c, ctx, probe, probeEval, ladder, verdict), verdict, quotesUsed };
    }

    // 3) the chosen size is decided on firm quotes only
    let final = probe;
    let finalEval = best;
    if (best.interpolated) {
      try {
        final = await quoteRoute(this.registry, hops, best.inputLamports, { ...opts, priority: "verify", maxWaitMs: 1_000 });
        quotesUsed += final.legs.length;
      } catch (err) {
        const e = err as RouteQuoteError;
        const verdict: EdgeVerdict = { trade: false, reason: e.code ?? "ROUTE_UNAVAILABLE", detail: `verification quote failed: ${e.message}`, usableEdgeEur: 0 };
        return { opportunity: this.build(c, ctx, probe, probeEval, ladder, verdict), verdict, quotesUsed };
      }
      const costs = this.costs(c, ctx, final.inputLamports, final.outputLamports, ctx.now() - final.oldestQuoteAt);
      finalEval = { sizeEur: best.sizeEur, inputLamports: final.inputLamports, outputLamports: final.outputLamports, costs, netEur: lamportsToEur(costs.usableEdgeLamports, ctx.solEur), interpolated: false };
      const idx = ladder.findIndex((e) => e.sizeEur === best.sizeEur);
      if (idx >= 0) ladder[idx] = finalEval;
    }
    const verdict = judgeEdge(finalEval.costs, this.thresholds(s), ctx.solEur);
    return { opportunity: this.build(c, ctx, final, finalEval, ladder, verdict), verdict, quotesUsed };
  }

  private build(c: Candidate, ctx: EvaluationContext, route: QuotedRoute, ev: SizeEvaluation, ladder: SizeEvaluation[], verdict: EdgeVerdict): Opportunity {
    const k = ev.costs;
    const input = k.inputLamports;
    return {
      id: randomUUID(),
      timestamp: ctx.now(),
      slot: Math.max(...route.legs.map((l) => l.slot ?? 0)) || c.slot,
      mode: ctx.mode,
      strategyType: c.strategyType,
      strategyVersionId: ctx.strategyVersionId,
      route: c.route,
      routeDexes: c.dexes,
      inputMint: c.route[0] as string,
      outputMint: c.route[c.route.length - 1] as string,
      tokenMint: c.tokenMint,
      sourceDex: c.dexes[0] as Opportunity["sourceDex"],
      destinationDex: c.dexes[c.dexes.length - 1] as Opportunity["destinationDex"],
      inputAmount: input,
      outputAmount: k.quotedOutputLamports,
      sizeEur: ev.sizeEur,
      solEur: ctx.solEur,
      grossProfit: k.grossProfitLamports,
      grossProfitPercent: k.grossProfitBps / 100,
      dexFees: k.dexFeesLamports,
      networkFee: k.baseFeeLamports,
      priorityFee: k.priorityFeeLamports,
      jitoTip: k.jitoTipLamports,
      priceImpact: Number(k.priceImpactLamports) / Number(input),
      expectedSlippage: k.expectedSlippageLamports,
      executionProbability: k.executionProbability,
      expectedFailureCost: k.expectedFailureCostLamports,
      safetyBuffer: k.safetyBufferLamports,
      expectedNetProfit: k.usableEdgeLamports,
      expectedNetProfitPercent: k.usableEdgeBps / 100,
      expectedNetProfitEur: lamportsToEur(k.usableEdgeLamports, ctx.solEur),
      quoteAge: ctx.now() - route.oldestQuoteAt,
      latencyEstimate: this.learning.latencyMs(),
      atomic: c.hops.length <= 4,
      status: verdict.trade ? "EXECUTABLE" : "REJECTED",
      rejectionReason: verdict.reason,
      rejectionDetail: verdict.detail,
      legs: route.legs,
      sizeLadder: ladder,
      costs: k,
      decisionLog: decisionLog(k),
    };
  }

  /** A candidate that never got firm quotes (budget, route, size cap) is still recorded. */
  private rejectEarly(c: Candidate, ctx: EvaluationContext, reason: RejectionReason, detail: string, quotesUsed: number): EvaluationResult {
    const verdict: EdgeVerdict = { trade: false, reason, detail, usableEdgeEur: 0 };
    const opportunity: Opportunity = {
      id: randomUUID(),
      timestamp: ctx.now(),
      slot: c.slot,
      mode: ctx.mode,
      strategyType: c.strategyType,
      strategyVersionId: ctx.strategyVersionId,
      route: c.route,
      routeDexes: c.dexes,
      inputMint: c.route[0] as string,
      outputMint: c.route[c.route.length - 1] as string,
      tokenMint: c.tokenMint,
      sourceDex: c.dexes[0] as Opportunity["sourceDex"],
      destinationDex: c.dexes[c.dexes.length - 1] as Opportunity["destinationDex"],
      inputAmount: 0n,
      outputAmount: 0n,
      sizeEur: 0,
      solEur: ctx.solEur,
      grossProfit: 0n,
      grossProfitPercent: c.netSpreadBps / 100,
      dexFees: 0n,
      networkFee: 0n,
      priorityFee: 0n,
      jitoTip: 0n,
      priceImpact: 0,
      expectedSlippage: 0n,
      executionProbability: 0,
      expectedFailureCost: 0n,
      safetyBuffer: 0n,
      expectedNetProfit: 0n,
      expectedNetProfitPercent: 0,
      expectedNetProfitEur: 0,
      quoteAge: 0,
      latencyEstimate: this.learning.latencyMs(),
      atomic: c.hops.length <= 4,
      status: "REJECTED",
      rejectionReason: reason,
      rejectionDetail: detail,
      legs: [] as Quote[],
      sizeLadder: [],
      costs: null,
      decisionLog: [{ label: "Screening spread after pool fees", bps: c.netSpreadBps, lamports: null }],
    };
    return { opportunity, verdict, quotesUsed };
  }
}
