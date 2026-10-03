import type { Settings } from "@solarbiter/shared";
import type { ValidationReport } from "./validation.js";

export interface GateCounts {
  /** All opportunities recorded in paper mode (incl. rejected ones). */
  paperOpportunities: number;
  /** Paper/shadow executions with a known outcome. */
  simulatedExecutions: number;
  latencySamples: number;
}

export interface GateCheck {
  name: string;
  ok: boolean;
  value: string;
  required: string;
}

export interface GateResult {
  ready: boolean;
  checks: GateCheck[];
}

/**
 * Live gate. Passing it only makes the bot LIVE_READY — a recommendation. Real money needs the
 * user's explicit "ENABLE LIVE TRADING" confirmation; the system never enables it itself.
 */
export function evaluateLiveGate(counts: GateCounts, report: ValidationReport | null, settings: Settings): GateResult {
  const l = settings.learning;
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);
  const checks: GateCheck[] = [
    { name: "Paper opportunities", ok: counts.paperOpportunities >= l.minPaperOpportunities, value: String(counts.paperOpportunities), required: `≥ ${l.minPaperOpportunities}` },
    { name: "Simulated executions", ok: counts.simulatedExecutions >= l.minSimulatedExecutions, value: String(counts.simulatedExecutions), required: `≥ ${l.minSimulatedExecutions}` },
    { name: "Latency samples", ok: counts.latencySamples >= l.minLatencySamples, value: String(counts.latencySamples), required: `≥ ${l.minLatencySamples}` },
  ];
  if (!report) {
    checks.push({ name: "Validation", ok: false, value: "not enough data", required: "chronological split + walk-forward" });
    return { ready: false, checks };
  }
  const all = [report.train, report.validation, report.oos];
  const totalNet = all.reduce((a, s) => a + s.netEur, 0);
  const n = all.reduce((a, s) => a + s.n, 0);
  const failures = all.reduce((a, s) => a + s.failureRate * s.n, 0);
  checks.push(
    { name: "Net expectancy (all paper trades)", ok: n > 0 && totalNet > 0, value: `${totalNet.toFixed(4)} €`, required: "> 0" },
    { name: "Out-of-sample expectancy", ok: report.oos.n >= 20 && report.oos.expectancyEur > 0, value: `${report.oos.expectancyEur.toFixed(5)} €/trade (n=${report.oos.n})`, required: "> 0, n ≥ 20" },
    { name: "Validation expectancy", ok: report.validation.n >= 20 && report.validation.expectancyEur > 0, value: `${report.validation.expectancyEur.toFixed(5)} €/trade`, required: "> 0" },
    { name: "Walk-forward stability", ok: report.stable, value: report.walkForward.map((f) => f.test.expectancyEur.toFixed(4)).join(" / "), required: "positive in ≥ 75 % of folds, stable accuracy" },
    { name: "Execution model accuracy", ok: (report.executionAccuracy ?? 0) >= l.minExecutionAccuracy, value: pct(report.executionAccuracy), required: `≥ ${pct(l.minExecutionAccuracy)}` },
    { name: "Slippage model accuracy", ok: (report.slippageAccuracy ?? 0) >= l.minSlippageAccuracy, value: pct(report.slippageAccuracy), required: `≥ ${pct(l.minSlippageAccuracy)}` },
    { name: "Fee model accuracy", ok: (report.feeAccuracy ?? 0) >= l.minFeeAccuracy, value: pct(report.feeAccuracy), required: `≥ ${pct(l.minFeeAccuracy)}` },
    { name: "Paper drawdown", ok: Math.max(...all.map((s) => s.maxDrawdownEur)) <= l.maxPaperDrawdownEur, value: `${Math.max(...all.map((s) => s.maxDrawdownEur)).toFixed(3)} €`, required: `≤ ${l.maxPaperDrawdownEur} €` },
    { name: "Failure rate", ok: n > 0 && failures / n <= l.maxFailureRate, value: pct(n ? failures / n : null), required: `≤ ${pct(l.maxFailureRate)}` },
  );
  return { ready: checks.every((c) => c.ok), checks };
}

export type LearningStatus = "COLLECTING_DATA" | "LEARNING" | "VALIDATING" | "LIVE_READY" | "DEGRADED";

/** 0–100 score shown in the UI: data volume, model accuracy, out-of-sample edge, stability. */
export function learningScore(counts: GateCounts, report: ValidationReport | null, gate: GateResult, settings: Settings): { score: number; status: LearningStatus } {
  const l = settings.learning;
  const frac = (x: number, need: number) => (need <= 0 ? 1 : Math.min(1, x / need));
  const data = (frac(counts.paperOpportunities, l.minPaperOpportunities) + frac(counts.simulatedExecutions, l.minSimulatedExecutions) + frac(counts.latencySamples, l.minLatencySamples)) / 3;
  let models = 0;
  let edge = 0;
  let stability = 0;
  if (report) {
    models = ((report.executionAccuracy ?? 0) + (report.slippageAccuracy ?? 0) + (report.feeAccuracy ?? 0)) / 3;
    edge = report.oos.n > 0 ? (report.oos.expectancyEur > 0 ? 1 : 0) * Math.min(1, report.oos.n / 50) : 0;
    stability = report.stable ? 1 : 0;
  }
  const score = Math.round(100 * (0.35 * data + 0.3 * models + 0.2 * edge + 0.15 * stability));
  let status: LearningStatus;
  if (gate.ready) status = "LIVE_READY";
  else if (data < 0.2) status = "COLLECTING_DATA";
  else if (report && report.oos.n >= 20 && report.oos.expectancyEur <= 0) status = "DEGRADED";
  else if (data < 1) status = "LEARNING";
  else status = "VALIDATING";
  return { score, status };
}
