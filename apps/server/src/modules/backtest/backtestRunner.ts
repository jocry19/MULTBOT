import type { Settings, StrategySpec } from "@multbot/shared";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import { HistoricalMarketView } from "../execution/simulator.js";
import { executionParamsFromSettings } from "../research/labeler.js";
import { loadStateTrades } from "../research/tradeLoader.js";
import { matchSpec } from "../strategy/evaluate.js";
import type { StrategyService } from "../strategy/strategyService.js";
import { runBacktest, type BacktestResult, type DecisionSample } from "./backtestEngine.js";

export interface BacktestCriteria {
  minTrades: number;
  minProfitFactor: number;
  maxPValue: number;
}

export const DEFAULT_BACKTEST_CRITERIA: BacktestCriteria = { minTrades: 30, minProfitFactor: 1.1, maxPValue: 0.1 };

/**
 * Loads decision samples + on-chain trades for a period, runs the backtest, persists everything
 * (backtests, backtest_trades, strategy_results) and returns a pass/fail verdict.
 */
export class BacktestRunner {
  constructor(
    private readonly db: Database,
    private readonly strategies: StrategyService,
    private readonly settings: () => Settings,
    private readonly log: Logger,
  ) {}

  async loadSamples(spec: StrategySpec, from: Date, to: Date, limit = 200_000): Promise<DecisionSample[]> {
    const rows = await this.db.many<{ id: number; ts: Date; mint: string; venue: "pump_curve" | "pump_amm"; age_sec: number; features: Record<string, number>; regime: { label?: string } | null }>(
      `SELECT id, ts, mint, venue, age_sec, features, regime FROM research_samples
        WHERE ts >= $1 AND ts <= $2 AND venue = ANY($3) ORDER BY ts LIMIT $4`,
      [from, to, spec.universe.venues, limit],
    );
    return rows.map((r) => ({ id: r.id, ts: r.ts.getTime(), mint: r.mint, venue: r.venue, ageSec: r.age_sec, features: r.features, regimeLabel: r.regime?.label ?? null }));
  }

  async run(versionId: string, period: { from: Date; to: Date }, criteria = DEFAULT_BACKTEST_CRITERIA): Promise<{ backtestId: number; result: BacktestResult; passed: boolean; reason: string }> {
    const version = await this.strategies.version(versionId);
    if (!version) throw new Error(`strategy version ${versionId} not found`);
    const s = this.settings();
    const exec = executionParamsFromSettings(s);
    const config = {
      positionSizeSol: s.trading.positionSizeSol,
      maxOpenPositions: s.trading.maxOpenPositions,
      exec,
      randomFailures: true,
      seed: versionId,
    };
    const inserted = await this.db.one<{ id: number }>(
      "INSERT INTO backtests (strategy_version_id, status, config, period_start, period_end) VALUES ($1, 'running', $2, $3, $4) RETURNING id",
      [versionId, JSON.stringify(config), period.from, period.to],
    );
    const backtestId = inserted?.id as number;
    try {
      const all = await this.loadSamples(version.spec, period.from, period.to);
      // only tokens that match at least once need market data
      const matching = all.filter((x) => matchSpec(version.spec, x.features, x.venue, x.ageSec).matched);
      const mints = [...new Set(matching.map((x) => x.mint))];
      const samples = all.filter((x) => mints.includes(x.mint));
      const view = new HistoricalMarketView();
      const maxHoldMs = version.spec.exit.maxHoldSec * 1000 + exec.executionDelayMs * 4 + 10 * 60_000;
      for (let i = 0; i < mints.length; i += 200) {
        const chunk = mints.slice(i, i + 200);
        const trades = await loadStateTrades(this.db, chunk, new Date(period.from.getTime() - 3_600_000), new Date(period.to.getTime() + maxHoldMs));
        for (const [m, arr] of trades) view.set(m, arr);
      }
      const result = runBacktest(version.spec, samples, view, config);
      const st = result.stats;
      let passed = true;
      let reason = "passed";
      if (st.n < criteria.minTrades) {
        passed = false;
        reason = "INSUFFICIENT_SAMPLES";
      } else if (st.mean <= 0) {
        passed = false;
        reason = "NEGATIVE_NET_EXPECTANCY";
      } else if (st.profitFactor < criteria.minProfitFactor) {
        passed = false;
        reason = "NEGATIVE_NET_EXPECTANCY";
      } else if (st.pValue > criteria.maxPValue) {
        passed = false;
        reason = "NOT_SIGNIFICANT";
      }
      const metrics = {
        stats: st,
        returnStats: result.returnStats,
        failedEntries: result.failedEntries,
        skipped: result.skipped,
        exitReasons: result.exitReasons,
        avgOpenPositions: result.avgOpenPositions,
        grossPnlSol: result.trades.reduce((sum, t) => sum + (t.result?.grossPnlSol ?? t.netSol), 0),
        netPnlSol: st.sum,
        passed,
        reason,
      };
      await this.db.tx(async (c) => {
        await c.query(
          `UPDATE backtests SET status = 'done', finished_at = now(), metrics = $2, equity_curve = $3, cost_breakdown = $4, regime_breakdown = $5 WHERE id = $1`,
          [backtestId, JSON.stringify(metrics), JSON.stringify(downsample(result.equity, 500)), JSON.stringify(result.costs), JSON.stringify(result.regimes)],
        );
        const rows = result.trades.map((t) => [
          backtestId,
          t.seq,
          t.mint,
          new Date(t.decisionTs),
          t.entry ? new Date(t.entry.execTs) : null,
          t.exit ? new Date(t.exit.execTs) : null,
          t.entry?.effectivePrice ?? null,
          t.exit?.effectivePrice ?? null,
          t.result?.grossPnlSol ?? t.netSol,
          t.netSol,
          t.netReturn,
          JSON.stringify(t.result?.costs ?? {}),
          t.exitReason,
          t.failed,
        ]);
        await this.db.insertMany(
          "backtest_trades",
          ["backtest_id", "seq", "mint", "decision_ts", "entry_ts", "exit_ts", "entry_price", "exit_price", "gross_pnl_sol", "net_pnl_sol", "net_return", "costs", "exit_reason", "failed"],
          rows,
          "",
          c,
        );
        await this.strategies.addResult(c, versionId, "backtest", { backtestId, ...metrics }, period);
      });
      this.log.info({ versionId, backtestId, trades: st.n, net: st.sum, passed, reason }, "backtest finished");
      return { backtestId, result, passed, reason };
    } catch (err) {
      await this.db.query("UPDATE backtests SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [backtestId, (err as Error).message]);
      throw err;
    }
  }
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)] as T);
  out.push(arr[arr.length - 1] as T);
  return out;
}
