import { randomUUID } from "node:crypto";
import type { DexRegistry } from "@solarbiter/dex";
import { closingGuard, type ClosingGuard } from "@solarbiter/profit-engine";
import type { RiskApproval, RiskEngine } from "@solarbiter/risk-engine";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, bps, lamportsToEur, type Opportunity, type Quote, type Settings } from "@solarbiter/shared";
import type { Portfolio } from "./portfolio.js";

/** Shadow mode: build the real transaction and run simulateTransaction with the bot wallet. */
export interface ShadowSimulator {
  simulate(o: Opportunity, guard: ClosingGuard): Promise<{ ok: boolean; error: string | null; unitsConsumed: number | null; logs: string[] }>;
}

/** Re-quote one leg with a given input at execution time. */
export type LegRequoter = (leg: Quote, amount: bigint) => Promise<Quote>;

/** Default re-quoter: the leg's own DEX adapter, highest non-final priority. */
export function registryRequoter(registry: DexRegistry, decimals: (mint: string) => number | undefined, forJitoBundle: boolean): LegRequoter {
  return async (leg, amount) => {
    const adapter = registry.require(leg.source);
    const inputDecimals = decimals(leg.inputMint);
    const outputDecimals = decimals(leg.outputMint);
    if (inputDecimals === undefined || outputDecimals === undefined) throw new Error("unknown token decimals");
    return adapter.getQuote({
      inputMint: leg.inputMint,
      outputMint: leg.outputMint,
      inputDecimals,
      outputDecimals,
      amount,
      slippageBps: leg.slippageBps,
      onlyDirectRoutes: true,
      forJitoBundle,
      priority: "requote",
      maxWaitMs: 2_000,
    });
  };
}

export type PaperStage = "DETECTED" | "QUOTE" | "SIMULATE" | "WAIT_LATENCY" | "REQUOTE" | "CALCULATE" | "CLOSE";

/** One paper/shadow trade — mirrors the paper_trades table. */
export interface PaperTradeRecord {
  id: string;
  opportunityId: string;
  strategyVersionId: string | null;
  shadow: boolean;
  tsDetected: number;
  tsExecuted: number | null;
  tsClosed: number;
  latencyMs: number;
  sizeEur: number;
  solEur: number;
  inputLamports: bigint;
  detectedOutput: bigint;
  expectedOutput: bigint;
  minOutput: bigint;
  simulatedOutput: bigint | null;
  slippageLamports: bigint | null;
  fees: { baseLamports: string; priorityLamports: string; jitoTipLamports: string; rentLockedLamports: string; paid: boolean };
  predictedNet: bigint;
  realizedNet: bigint;
  realizedNetEur: number;
  /** null = outcome unknown (re-quote unavailable); excluded from learning and statistics. */
  success: boolean | null;
  failureReason: string | null;
  predictionErrorBps: number | null;
  route: { mints: string[]; dexes: string[]; legs: { dex: string; pool: string; label: string; in: string; out: string; minOut: string }[] };
  simulation: { ok: boolean; error: string | null; unitsConsumed: number | null; logs: string[] } | null;
  status: "CLOSED" | "FAILED";
  stages: { stage: PaperStage; at: number; note?: string }[];
}

export interface PaperExecutorDeps {
  risk: RiskEngine;
  requote: LegRequoter;
  simulator: ShadowSimulator | null;
  settings: () => Settings;
  latencyMs: () => number;
  /** Transactions go out as Jito bundles (a reverting bundle is not included and costs nothing). */
  viaJito: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Paper / shadow execution on LIVE market data:
 *   DETECTED → QUOTE → (SIMULATE, shadow only) → WAIT LATENCY → REQUOTE → CALCULATE → CLOSE
 * The result is what the atomic transaction would have produced after the real latency: every leg
 * is re-quoted with the amounts the transaction would actually swap, and the same minimum-output
 * guards decide between success and revert. Profits are never assumed — they come from re-quotes.
 * Not observable in paper: competition for block space (measured in live and compared).
 */
export class PaperExecutor {
  constructor(private readonly d: PaperExecutorDeps) {}

  async execute(o: Opportunity, approval: RiskApproval | null, portfolio: Portfolio): Promise<PaperTradeRecord> {
    const stages: PaperTradeRecord["stages"] = [{ stage: "DETECTED", at: o.timestamp }];
    const check = this.d.risk.consumeApproval(approval, o, this.d.now());
    if (!check.ok) throw new Error(`paper execution refused: ${check.reason}`);
    if (portfolio.mode !== "paper") throw new Error("paper executor requires the paper portfolio");
    stages.push({ stage: "QUOTE", at: this.d.now(), note: `${o.legs.length} firm legs, age ${o.quoteAge} ms` });

    const settings = this.d.settings();
    const guard = closingGuard(o, settings.strategy.minNetProfitEur);
    const shadow = this.d.simulator !== null;
    const base = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE);
    const viaJito = this.d.viaJito();
    const detectedOutput = o.outputAmount;
    const expectedOutput = detectedOutput - o.expectedSlippage;
    const record = (p: Partial<PaperTradeRecord> & Pick<PaperTradeRecord, "success" | "failureReason" | "realizedNet" | "status">): PaperTradeRecord => ({
      id: randomUUID(),
      opportunityId: o.id,
      strategyVersionId: o.strategyVersionId,
      shadow,
      tsDetected: o.timestamp,
      tsExecuted: null,
      tsClosed: this.d.now(),
      latencyMs: 0,
      sizeEur: o.sizeEur,
      solEur: o.solEur,
      inputLamports: o.inputAmount,
      detectedOutput,
      expectedOutput,
      minOutput: guard?.enforcedMinOutLamports ?? 0n,
      simulatedOutput: null,
      slippageLamports: null,
      fees: { baseLamports: base.toString(), priorityLamports: o.priorityFee.toString(), jitoTipLamports: o.jitoTip.toString(), rentLockedLamports: (o.costs?.rentLockedLamports ?? 0n).toString(), paid: false },
      predictedNet: o.expectedNetProfit,
      realizedNetEur: lamportsToEur(p.realizedNet, o.solEur),
      predictionErrorBps: null,
      route: {
        mints: o.route,
        dexes: o.routeDexes,
        legs: o.legs.map((l) => ({ dex: l.source, pool: l.route[0]?.pool ?? "", label: l.route[0]?.label ?? "", in: l.inputAmount.toString(), out: l.outputAmount.toString(), minOut: l.minOutputAmount.toString() })),
      },
      simulation: null,
      stages,
      ...p,
    });

    if (!guard) {
      stages.push({ stage: "CLOSE", at: this.d.now(), note: "profit guard unreachable" });
      return record({ success: null, failureReason: "GUARD_UNREACHABLE", realizedNet: 0n, status: "FAILED" });
    }

    portfolio.open();
    try {
      // SIMULATE (shadow): the real transaction against the current chain state
      let simulation: PaperTradeRecord["simulation"] = null;
      if (this.d.simulator) {
        simulation = await this.d.simulator.simulate(o, guard);
        stages.push({ stage: "SIMULATE", at: this.d.now(), note: simulation.ok ? `ok, ${simulation.unitsConsumed ?? "?"} CU` : simulation.error ?? "failed" });
        if (!simulation.ok) {
          // a failing simulation is never sent: no cost, but it is an execution failure
          const r = record({ success: false, failureReason: `SIMULATION_FAILED: ${simulation.error ?? "unknown"}`, realizedNet: 0n, status: "FAILED", simulation });
          portfolio.close({ id: r.id, mode: "paper", closedAt: r.tsClosed, sizeEur: o.sizeEur, netLamports: 0n, netEur: 0, success: false });
          stages.push({ stage: "CLOSE", at: this.d.now() });
          return r;
        }
      }

      // WAIT LATENCY: decision → landing
      const latency = Math.max(0, Math.round(this.d.latencyMs()));
      await this.d.sleep(latency);
      const executedAt = this.d.now();
      stages.push({ stage: "WAIT_LATENCY", at: executedAt, note: `${latency} ms` });

      // REQUOTE with exactly the amounts the transaction swaps
      let reverted: string | null = null;
      let finalOut = 0n;
      try {
        let amount = o.inputAmount;
        for (let i = 0; i < o.legs.length; i++) {
          const leg = o.legs[i] as Quote;
          const isLast = i === o.legs.length - 1;
          const q = await this.d.requote(leg, amount);
          const minOut = isLast ? guard.enforcedMinOutLamports : leg.minOutputAmount;
          if (q.outputAmount < minOut) {
            reverted = `leg ${i + 1} output ${q.outputAmount} < minimum ${minOut}`;
            finalOut = 0n;
            break;
          }
          finalOut = q.outputAmount;
          // intermediate legs sell a fixed amount (the previous minimum); the closing leg sells what arrived
          const nextIsLast = i + 1 === o.legs.length - 1;
          amount = nextIsLast ? q.outputAmount : leg.minOutputAmount;
        }
      } catch (err) {
        stages.push({ stage: "REQUOTE", at: this.d.now(), note: `unavailable: ${(err as Error).message}` });
        const r = record({ success: null, failureReason: "REQUOTE_UNAVAILABLE", realizedNet: 0n, status: "FAILED", tsExecuted: executedAt, latencyMs: latency, simulation });
        portfolio.close({ id: r.id, mode: "paper", closedAt: r.tsClosed, sizeEur: o.sizeEur, netLamports: 0n, netEur: 0, success: null });
        stages.push({ stage: "CLOSE", at: this.d.now() });
        return r;
      }
      stages.push({ stage: "REQUOTE", at: this.d.now(), note: reverted ?? `final ${finalOut}` });

      // CALCULATE
      const costs = base + o.priorityFee + o.jitoTip;
      let realizedNet: bigint;
      let paid: boolean;
      if (reverted) {
        // reverting bundle: not included → nothing paid; reverting RPC transaction: fees paid
        paid = !viaJito;
        realizedNet = viaJito ? 0n : -(base + o.priorityFee);
      } else {
        paid = true;
        realizedNet = finalOut - o.inputAmount - costs;
      }
      const success = reverted === null;
      stages.push({ stage: "CALCULATE", at: this.d.now(), note: `net ${realizedNet} lamports` });
      const r = record({
        success,
        failureReason: reverted ? `REVERTED: ${reverted}` : null,
        realizedNet,
        status: success ? "CLOSED" : "FAILED",
        tsExecuted: executedAt,
        latencyMs: latency,
        simulatedOutput: reverted ? null : finalOut,
        slippageLamports: reverted ? null : detectedOutput - finalOut,
        predictionErrorBps: bps(o.expectedNetProfit - realizedNet, o.inputAmount),
        simulation,
        fees: { baseLamports: base.toString(), priorityLamports: o.priorityFee.toString(), jitoTipLamports: o.jitoTip.toString(), rentLockedLamports: (o.costs?.rentLockedLamports ?? 0n).toString(), paid },
      });
      portfolio.close({ id: r.id, mode: "paper", closedAt: r.tsClosed, sizeEur: o.sizeEur, netLamports: realizedNet, netEur: r.realizedNetEur, success });
      stages.push({ stage: "CLOSE", at: this.d.now() });
      return r;
    } catch (err) {
      portfolio.abort();
      throw err;
    }
  }
}
