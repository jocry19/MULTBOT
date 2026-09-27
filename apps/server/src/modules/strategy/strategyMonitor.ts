import type { Settings, StrategyStatus } from "@multbot/shared";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import { mean, performance, welchGreater } from "../stats/stats.js";
import type { ResearchNotifier } from "../research/researchRuntime.js";
import type { StrategyService } from "./strategyService.js";

/**
 * Paper validation and strategy decay monitoring.
 *
 *  - PAPER_TRADING → PAPER_VALIDATED when the configured evidence criteria are met. This is a
 *    recommendation for review only; enabling real money always requires a user action.
 *  - PAPER_TRADING → REJECTED when paper results are significantly negative.
 *  - PAPER_VALIDATED / LIVE_ENABLED → DEGRADED when the rolling window is statistically worse than
 *    the reference period (Welch test) — not merely because of a few losses. Paper trading continues.
 *  - DEGRADED → PAPER_VALIDATED when the rolling window recovers (live must be re-enabled by the user).
 */

type ClosedTrade = { net_pnl_sol: number; net_return: number; closed_at: Date; features: Record<string, number> | null };

export interface RollingMetrics {
  window: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  decayPValue: number | null;
  featureShift: { feature: string; psi: number }[];
}

/** Population stability index between two samples (10 quantile bins of the reference). */
export function psi(reference: number[], recent: number[]): number {
  if (reference.length < 20 || recent.length < 10) return 0;
  const sorted = [...reference].sort((a, b) => a - b);
  const edges = Array.from({ length: 9 }, (_, i) => sorted[Math.floor(((i + 1) / 10) * (sorted.length - 1))] as number);
  const bin = (v: number) => {
    let b = 0;
    while (b < edges.length && v > (edges[b] as number)) b++;
    return b;
  };
  const r = new Array(10).fill(0);
  const c = new Array(10).fill(0);
  for (const v of reference) r[bin(v)]++;
  for (const v of recent) c[bin(v)]++;
  let s = 0;
  for (let i = 0; i < 10; i++) {
    const p = Math.max(1e-4, r[i] / reference.length);
    const q = Math.max(1e-4, c[i] / recent.length);
    s += (q - p) * Math.log(q / p);
  }
  return s;
}

export class StrategyMonitor {
  constructor(
    private readonly db: Database,
    private readonly strategies: StrategyService,
    private readonly settings: () => Settings,
    private readonly notify: ResearchNotifier,
    private readonly log: Logger,
  ) {}

  async run(): Promise<void> {
    const monitored = await this.strategies.list(["PAPER_TRADING", "PAPER_VALIDATED", "LIVE_ENABLED", "DEGRADED"]);
    for (const s of monitored) {
      if (!s.current_version_id) continue;
      try {
        await this.evaluate(s.id, s.status, s.current_version_id);
      } catch (err) {
        this.log.error({ err, strategy: s.id }, "strategy monitoring failed");
      }
    }
  }

  async evaluate(strategyId: string, status: StrategyStatus, versionId: string): Promise<void> {
    const cfg = this.settings().research;
    const trades = await this.db.many<ClosedTrade>(
      `SELECT net_pnl_sol, net_return, closed_at, features FROM paper_trades
        WHERE strategy_version_id = $1 AND status = 'CLOSED' AND net_pnl_sol IS NOT NULL ORDER BY closed_at`,
      [versionId],
    );
    const pnl = trades.map((t) => t.net_pnl_sol);
    const overall = performance(pnl);
    const W = cfg.decayWindowTrades;
    const recent = trades.slice(-W);
    const reference = trades.slice(0, Math.max(0, trades.length - W));
    const rollingPerf = performance(recent.map((t) => t.net_pnl_sol));
    let decayP: number | null = null;
    if (reference.length >= W && recent.length >= W) {
      decayP = welchGreater(reference.map((t) => t.net_pnl_sol), recent.map((t) => t.net_pnl_sol)).pValue;
    }
    const featureShift: RollingMetrics["featureShift"] = [];
    if (reference.length >= 20 && recent.length >= 10) {
      const keys = new Set<string>();
      for (const t of trades.slice(-5)) for (const k of Object.keys(t.features ?? {})) keys.add(k);
      for (const k of [...keys].slice(0, 40)) {
        const ref = reference.map((t) => t.features?.[k]).filter((v): v is number => v !== undefined);
        const rec = recent.map((t) => t.features?.[k]).filter((v): v is number => v !== undefined);
        const v = psi(ref, rec);
        if (v > 0.1) featureShift.push({ feature: k, psi: Number(v.toFixed(3)) });
      }
      featureShift.sort((a, b) => b.psi - a.psi);
    }
    const rolling: RollingMetrics = {
      window: recent.length,
      expectancy: rollingPerf.mean,
      winRate: rollingPerf.winRate,
      profitFactor: Number.isFinite(rollingPerf.profitFactor) ? rollingPerf.profitFactor : 999,
      maxDrawdown: rollingPerf.maxDrawdown,
      decayPValue: decayP,
      featureShift: featureShift.slice(0, 8),
    };
    const confidence = 1 - overall.pValue;
    await this.strategies.addResult(this.db, versionId, "paper", {
      stats: overall,
      rolling,
      confidence,
      grossVsNet: null,
      updatedAt: new Date().toISOString(),
    });

    const v = cfg.paperValidation;
    const meetsValidation =
      overall.n >= v.minTrades &&
      overall.mean > 0 &&
      overall.profitFactor >= v.minProfitFactor &&
      confidence >= v.minConfidence &&
      overall.maxDrawdown <= v.maxDrawdownSol;

    if (status === "PAPER_TRADING") {
      if (meetsValidation) {
        await this.strategies.transition(strategyId, "PAPER_VALIDATED", "paper evidence criteria met — ready for review", "system", { stats: overall });
        this.notify.activity("success", "strategy", `${strategyId} appears sufficiently validated for review (${overall.n} paper trades, PF ${overall.profitFactor.toFixed(2)}). Live trading stays locked until you enable it.`, {
          strategyId,
        });
      } else if (overall.n >= v.minTrades && overall.mean < 0 && overall.pValue > 0.95) {
        await this.strategies.transition(strategyId, "REJECTED", "PAPER_FAILED: significantly negative paper results", "system", { stats: overall });
        this.notify.activity("warning", "strategy", `${strategyId} rejected: paper trading significantly negative (${overall.n} trades)`, { strategyId });
      }
      return;
    }

    if (status === "PAPER_VALIDATED" || status === "LIVE_ENABLED") {
      const degraded = decayP !== null && decayP < 0.05 && rollingPerf.mean <= 0;
      if (degraded) {
        await this.strategies.transition(strategyId, "DEGRADED", `rolling window significantly worse (p=${decayP?.toFixed(3)}), expectancy ${rollingPerf.mean.toFixed(5)} SOL`, "system", {
          rolling,
        });
        this.notify.activity("warning", "strategy", `${strategyId} marked DEGRADED — statistically significant performance decay. Paper trading continues; live entries stopped.`, {
          strategyId,
          rolling,
        });
      }
      return;
    }

    if (status === "DEGRADED") {
      const recovered = recent.length >= W && rollingPerf.mean > 0 && rollingPerf.pValue < 0.2 && rollingPerf.profitFactor >= v.minProfitFactor;
      const failing = recent.length >= W && reference.length >= W && rollingPerf.mean < 0 && mean(pnl.slice(-2 * W)) < 0 && rollingPerf.pValue > 0.95;
      if (recovered) {
        await this.strategies.transition(strategyId, "PAPER_VALIDATED", "rolling window recovered", "system", { rolling });
        this.notify.activity("info", "strategy", `${strategyId} recovered from DEGRADED (paper). Live trading must be re-enabled manually.`, { strategyId });
      } else if (failing) {
        await this.strategies.transition(strategyId, "REJECTED", "PAPER_FAILED: persistent significant decay", "system", { rolling });
        this.notify.activity("warning", "strategy", `${strategyId} rejected after persistent decay`, { strategyId });
      }
    }
  }
}
