import type { TradeMode } from "@multbot/shared";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import { mean, tTestGreater } from "../stats/stats.js";

/**
 * Context-aware learning from closed trades (paper and live, always labelled separately).
 *
 * Not "profit = good, loss = bad": every trade is judged on two independent axes
 *   decision quality — was the decision consistent with the evidence available at entry?
 *                      (positive expected net return after costs, regime covered by evidence,
 *                       execution within expectations, fresh data)
 *   outcome quality  — win / loss / flat
 * A loss after a good decision is variance; a win after a poor decision is luck.
 *
 * Systematic prediction errors lead to actions: recalibrate expectations, flag regimes where the
 * strategy under-performs, flag execution issues, or request a re-test.
 */

type TradeRow = {
  id: string;
  strategy_version_id: string;
  net_return: number | null;
  net_pnl_sol: number | null;
  entry_slippage_sol: number;
  position_size_sol: number;
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  regime: { label?: string } | null;
  exit_reason: string | null;
  decision_ts: Date;
  opened_at: Date | null;
};

export type DecisionQuality = "good" | "acceptable" | "poor";
export type OutcomeQuality = "win" | "loss" | "flat";

export interface Assessment {
  predicted: number | null;
  actual: number;
  error: number | null;
  decisionQuality: DecisionQuality;
  outcomeQuality: OutcomeQuality;
  issues: string[];
  attribution: Record<string, number | string | null>;
}

export function assessTrade(t: TradeRow): Assessment | null {
  if (t.net_return === null) return null;
  const expected = t.expected ?? {};
  const predicted = typeof expected.expectedNetReturn === "number" ? expected.expectedNetReturn : null;
  const expectedSlippage = typeof expected.expectedSlippageSol === "number" ? expected.expectedSlippageSol : null;
  const regimeOk = expected.regimeCovered !== false;
  const issues: string[] = [];
  if (predicted !== null && predicted <= 0) issues.push("expected net return not positive at entry");
  if (!regimeOk) issues.push("market regime not covered by strategy evidence");
  if (expectedSlippage !== null && t.entry_slippage_sol > Math.max(2 * expectedSlippage, expectedSlippage + 0.0005)) {
    issues.push("entry slippage far above expectation");
  }
  if (typeof expected.dataAgeSec === "number" && expected.dataAgeSec > 20) issues.push("stale market data at decision");
  const decisionQuality: DecisionQuality = issues.length === 0 ? "good" : issues.length === 1 ? "acceptable" : "poor";
  const outcomeQuality: OutcomeQuality = Math.abs(t.net_return) < 0.002 ? "flat" : t.net_return > 0 ? "win" : "loss";
  const slippageShare = t.position_size_sol > 0 ? t.entry_slippage_sol / t.position_size_sol : null;
  return {
    predicted,
    actual: t.net_return,
    error: predicted !== null ? t.net_return - predicted : null,
    decisionQuality,
    outcomeQuality,
    issues,
    attribution: {
      exitReason: t.exit_reason,
      regime: t.regime?.label ?? null,
      slippageShare,
      marketMove: typeof t.actual?.marketMove === "number" ? (t.actual.marketMove as number) : null,
    },
  };
}

export class LearningEngine {
  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  /** Assess all closed trades that were not assessed yet; then derive per-version actions. */
  async run(): Promise<number> {
    let n = 0;
    for (const mode of ["paper", "live"] as TradeMode[]) {
      const table = mode === "paper" ? "paper_trades" : "live_trades";
      const rows = await this.db.many<TradeRow>(
        `SELECT t.id, t.strategy_version_id, t.net_return, t.net_pnl_sol, t.entry_slippage_sol, t.position_size_sol, t.expected, t.actual, t.regime, t.exit_reason, t.decision_ts, t.opened_at
           FROM ${table} t LEFT JOIN learning_updates l ON l.mode = $1 AND l.trade_id = t.id
          WHERE t.status = 'CLOSED' AND l.id IS NULL ORDER BY t.closed_at LIMIT 2000`,
        [mode],
      );
      for (const t of rows) {
        const a = assessTrade(t);
        if (!a) continue;
        await this.db.query(
          `INSERT INTO learning_updates (mode, trade_id, strategy_version_id, prediction, actual, prediction_error, decision_quality, outcome_quality, attribution, action)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'none') ON CONFLICT (mode, trade_id) DO NOTHING`,
          [
            mode,
            t.id,
            t.strategy_version_id,
            JSON.stringify({ expectedNetReturn: a.predicted, ...(t.expected ?? {}) }),
            JSON.stringify({ netReturn: a.actual, ...(t.actual ?? {}) }),
            a.error,
            a.decisionQuality,
            a.outcomeQuality,
            JSON.stringify({ ...a.attribution, issues: a.issues }),
          ],
        );
        n++;
      }
    }
    if (n > 0) await this.deriveActions();
    return n;
  }

  /**
   * Per strategy version and mode: detect systematic bias of predictions, regime-specific
   * under-performance and execution problems; store calibrated expectations in learning_state.
   */
  async deriveActions(): Promise<void> {
    const versions = await this.db.many<{ strategy_version_id: string; mode: TradeMode }>(
      "SELECT DISTINCT strategy_version_id, mode FROM learning_updates WHERE strategy_version_id IS NOT NULL",
    );
    for (const { strategy_version_id: vid, mode } of versions) {
      const rows = await this.db.many<{ prediction_error: number | null; decision_quality: DecisionQuality; outcome_quality: OutcomeQuality; attribution: Record<string, unknown>; actual: { netReturn?: number } }>(
        `SELECT prediction_error, decision_quality, outcome_quality, attribution, actual FROM learning_updates
          WHERE strategy_version_id = $1 AND mode = $2 ORDER BY ts DESC LIMIT 200`,
        [vid, mode],
      );
      const errors = rows.map((r) => r.prediction_error).filter((e): e is number => e !== null);
      const actions: string[] = [];
      // systematic over-estimation: errors significantly below zero
      if (errors.length >= 20) {
        const neg = tTestGreater(errors.map((e) => -e));
        if (neg.pValue < 0.05) actions.push("recalibrate");
        if (neg.pValue < 0.01 && mean(errors) < -0.02) actions.push("retest");
      }
      // regime-specific under-performance
      const byRegime = new Map<string, number[]>();
      for (const r of rows) {
        const label = String(r.attribution.regime ?? "unknown");
        const v = r.actual.netReturn;
        if (typeof v === "number") byRegime.set(label, [...(byRegime.get(label) ?? []), v]);
      }
      const weakRegimes = [...byRegime.entries()].filter(([, v]) => v.length >= 10 && mean(v) < 0 && tTestGreater(v.map((x) => -x)).pValue < 0.1).map(([k]) => k);
      if (weakRegimes.length > 0) actions.push("flag_regime");
      const poorDecisions = rows.filter((r) => r.decision_quality === "poor").length;
      if (rows.length >= 20 && poorDecisions / rows.length > 0.3) actions.push("flag_execution");
      // good decisions with losses = variance; track the share (helps interpret results)
      const goodLosses = rows.filter((r) => r.decision_quality === "good" && r.outcome_quality === "loss").length;
      const poorWins = rows.filter((r) => r.decision_quality !== "good" && r.outcome_quality === "win").length;
      const calibratedExpectation = errors.length >= 20 ? mean(rows.map((r) => r.actual.netReturn).filter((x): x is number => typeof x === "number")) : null;
      await this.db.query(
        `INSERT INTO learning_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [
          `strategy:${vid}:${mode}`,
          JSON.stringify({
            trades: rows.length,
            meanPredictionError: errors.length > 0 ? mean(errors) : null,
            calibratedExpectation,
            actions,
            weakRegimes,
            decisionQuality: {
              good: rows.filter((r) => r.decision_quality === "good").length,
              acceptable: rows.filter((r) => r.decision_quality === "acceptable").length,
              poor: poorDecisions,
            },
            goodDecisionLosses: goodLosses,
            poorDecisionWins: poorWins,
          }),
        ],
      );
      if (actions.length > 0) this.log.info({ versionId: vid, mode, actions, weakRegimes }, "learning actions derived");
    }
  }
}
