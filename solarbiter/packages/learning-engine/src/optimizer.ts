import { mean, welchGreater, type Settings } from "@solarbiter/shared";
import type { LearningSample } from "./models.js";
import { chronoSplit, setPerformance, type SetPerformance } from "./validation.js";

/** The self-tunable decision thresholds the optimizer may change (never risk limits). */
export interface ThresholdSet {
  minNetProfitEur: number;
  minNetProfitPercent: number;
  minExecutionProbability: number;
  safetyBufferBps: number;
}

export function thresholdsOf(s: Settings["strategy"]): ThresholdSet {
  return { minNetProfitEur: s.minNetProfitEur, minNetProfitPercent: s.minNetProfitPercent, minExecutionProbability: s.minExecutionProbability, safetyBufferBps: s.safetyBufferBps };
}

/**
 * Which recorded trades would a threshold set still have taken? Only thresholds at least as strict
 * as the ones the data was collected under can be evaluated honestly (untaken opportunities have
 * no outcome), so the optimizer only searches in that direction.
 */
export function replay(samples: LearningSample[], t: ThresholdSet, base: ThresholdSet): LearningSample[] {
  const extraBuffer = Math.max(0, t.safetyBufferBps - base.safetyBufferBps);
  return samples.filter((s) => {
    const edgeBps = s.usableEdgeBps - extraBuffer;
    const edgeEur = s.usableEdgeEur - (s.inputLamports * extraBuffer * s.solEur) / 1e4 / 1e9;
    return edgeEur >= t.minNetProfitEur && edgeBps / 100 >= t.minNetProfitPercent && s.predictedP >= t.minExecutionProbability;
  });
}

export interface OptimizationResult {
  proposal: ThresholdSet | null;
  reason: string;
  current: { train: SetPerformance; validation: SetPerformance; oos: SetPerformance };
  candidate: { thresholds: ThresholdSet; train: SetPerformance; validation: SetPerformance; oos: SetPerformance } | null;
  evaluated: number;
}

/**
 * Grid search on the training split, accepted only if it also beats the current thresholds on the
 * validation split AND does not do worse out of sample. Stricter-only by construction.
 */
export function optimizeThresholds(samples: LearningSample[], strategy: Settings["strategy"], splits: [number, number, number], minTrades = 20): OptimizationResult {
  const base = thresholdsOf(strategy);
  const { train, validation, oos } = chronoSplit(samples, splits);
  const current = { train: setPerformance(train), validation: setPerformance(validation), oos: setPerformance(oos) };
  const grid: ThresholdSet[] = [];
  for (const a of [1, 1.5, 2, 3])
    for (const b of [1, 1.5, 2])
      for (const c of [0, 0.1, 0.2])
        for (const d of [0, 5, 10]) {
          if (a === 1 && b === 1 && c === 0 && d === 0) continue;
          grid.push({
            minNetProfitEur: base.minNetProfitEur * a,
            minNetProfitPercent: base.minNetProfitPercent * b,
            minExecutionProbability: Math.min(0.99, base.minExecutionProbability + c),
            safetyBufferBps: base.safetyBufferBps + d,
          });
        }
  let best: { t: ThresholdSet; score: number } | null = null;
  for (const t of grid) {
    const tr = replay(train, t, base);
    if (tr.length < minTrades) continue;
    const score = setPerformance(tr).netEur;
    if (!best || score > best.score) best = { t, score };
  }
  if (!best) return { proposal: null, reason: "not enough trades for any stricter threshold set", current, candidate: null, evaluated: grid.length };
  const cand = {
    thresholds: best.t,
    train: setPerformance(replay(train, best.t, base)),
    validation: setPerformance(replay(validation, best.t, base)),
    oos: setPerformance(replay(oos, best.t, base)),
  };
  if (best.score <= current.train.netEur) return { proposal: null, reason: "current thresholds are already best on the training split", current, candidate: cand, evaluated: grid.length };
  if (cand.validation.n < minTrades) return { proposal: null, reason: "too few validation trades under the candidate thresholds", current, candidate: cand, evaluated: grid.length };
  if (cand.validation.netEur <= current.validation.netEur) return { proposal: null, reason: "candidate does not beat the current thresholds on validation data", current, candidate: cand, evaluated: grid.length };
  if (cand.oos.netEur < current.oos.netEur) return { proposal: null, reason: "candidate is worse out of sample", current, candidate: cand, evaluated: grid.length };
  return { proposal: best.t, reason: "better on training and validation, not worse out of sample", current, candidate: cand, evaluated: grid.length };
}

/**
 * Automatic rollback: after enough trades a new strategy version must not be clearly worse than
 * its parent (lower expectancy with statistical support, or negative where the parent was positive).
 */
export function shouldRollback(versionNetEur: number[], parentNetEur: number[], minTrades = 30): { rollback: boolean; reason: string } {
  if (versionNetEur.length < minTrades) return { rollback: false, reason: `${versionNetEur.length}/${minTrades} trades on the new version` };
  const mv = mean(versionNetEur);
  const mp = parentNetEur.length ? mean(parentNetEur) : 0;
  if (mv < 0 && mp >= 0) return { rollback: true, reason: `negative expectancy ${mv.toFixed(5)} €/trade (parent ${mp.toFixed(5)})` };
  if (parentNetEur.length >= minTrades) {
    const w = welchGreater(parentNetEur, versionNetEur);
    if (w.pValue < 0.05) return { rollback: true, reason: `significantly worse than parent (p = ${w.pValue.toFixed(3)})` };
  }
  return { rollback: false, reason: "performing in line with or better than the parent" };
}
