import { mean, tTestGreater, type LiveLevel, type Settings } from "@solarbiter/shared";

export interface LevelTradeStats {
  /** Net PnL (EUR) of every live trade at the current level, oldest first. */
  netEur: number[];
  failures: number;
  attempts: number;
  consecutiveFailures: number;
  drawdownEur: number;
  /** Live expectancy minus paper expectancy for the same opportunities (bps, negative = worse live). */
  liveVsPaperBps: number | null;
}

export type LevelAction =
  | { action: "keep"; level: LiveLevel; reason: string }
  | { action: "downgrade"; level: LiveLevel; reason: string }
  | { action: "stop_live"; level: LiveLevel; reason: string };

/**
 * Automatic risk REDUCTION for live trading. Bad live performance lowers the level; at level 1 it
 * stops live trading and returns to paper. There is no automatic upgrade (see levelUpEligibility).
 */
export function evaluateLiveLevel(level: LiveLevel, st: LevelTradeStats, settings: Settings): LevelAction {
  const l = settings.learning;
  const r = settings.risk;
  const problems: string[] = [];
  if (st.consecutiveFailures >= r.maxConsecutiveFailures) problems.push(`${st.consecutiveFailures} consecutive failures`);
  if (st.attempts >= 10 && st.failures / st.attempts > l.maxFailureRate) problems.push(`failure rate ${((100 * st.failures) / st.attempts).toFixed(0)} %`);
  if (st.drawdownEur > r.dailyLossLimitEur) problems.push(`drawdown ${st.drawdownEur.toFixed(2)} € > ${r.dailyLossLimitEur} €`);
  if (st.netEur.length >= 10 && mean(st.netEur) < 0) problems.push(`negative live expectancy ${mean(st.netEur).toFixed(4)} €/trade`);
  if (st.liveVsPaperBps !== null && st.liveVsPaperBps < -l.liveDegradationBps) problems.push(`live ${Math.abs(st.liveVsPaperBps).toFixed(1)} bps worse than paper`);
  if (problems.length === 0) return { action: "keep", level, reason: "live performance within limits" };
  if (level > 1) return { action: "downgrade", level: (level - 1) as LiveLevel, reason: problems.join("; ") };
  return { action: "stop_live", level: 1, reason: `${problems.join("; ")} → live paused, back to paper` };
}

/**
 * A higher level only becomes ELIGIBLE: enough live trades at the current level, a statistically
 * positive expectancy and an acceptable failure rate. The user must confirm the upgrade.
 */
export function levelUpEligibility(level: LiveLevel, st: LevelTradeStats, settings: Settings): { eligible: boolean; next: LiveLevel | null; reasons: string[] } {
  const reasons: string[] = [];
  if (level >= 4) return { eligible: false, next: null, reasons: ["already at the highest level"] };
  const need = settings.learning.levelUpMinTrades;
  if (st.netEur.length < need) reasons.push(`${st.netEur.length}/${need} live trades at level ${level}`);
  if (st.netEur.length >= 2) {
    const t = tTestGreater(st.netEur, 0);
    if (!(t.pValue < 0.05)) reasons.push(`expectancy not significantly positive (p = ${t.pValue.toFixed(3)})`);
  } else reasons.push("not enough trades for a significance test");
  if (st.attempts > 0 && st.failures / st.attempts > settings.learning.maxFailureRate) reasons.push("failure rate too high");
  if (st.liveVsPaperBps !== null && st.liveVsPaperBps < -settings.learning.liveDegradationBps) reasons.push("live performance below paper");
  return { eligible: reasons.length === 0, next: (level + 1) as LiveLevel, reasons };
}
