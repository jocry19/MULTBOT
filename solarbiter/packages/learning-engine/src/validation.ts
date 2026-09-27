import { maxDrawdown, mean, tTestGreater } from "@solarbiter/shared";
import { ExecutionModel, SlippageModel, type LearningSample } from "./models.js";

/** Chronological split (no shuffling — the future never leaks into training). */
export function chronoSplit<T extends { ts: number }>(xs: T[], splits: [number, number, number]): { train: T[]; validation: T[]; oos: T[] } {
  const s = [...xs].sort((a, b) => a.ts - b.ts);
  const total = splits[0] + splits[1] + splits[2];
  const a = Math.floor((s.length * splits[0]) / total);
  const b = Math.floor((s.length * (splits[0] + splits[1])) / total);
  return { train: s.slice(0, a), validation: s.slice(a, b), oos: s.slice(b) };
}

/** Expanding-window walk-forward folds: train on everything before each test block. */
export function walkForward<T extends { ts: number }>(xs: T[], folds: number): { train: T[]; test: T[] }[] {
  const s = [...xs].sort((a, b) => a.ts - b.ts);
  const block = Math.floor(s.length / (folds + 1));
  if (block < 1) return [];
  const out: { train: T[]; test: T[] }[] = [];
  for (let k = 1; k <= folds; k++) out.push({ train: s.slice(0, k * block), test: s.slice(k * block, k === folds ? s.length : (k + 1) * block) });
  return out;
}

/** 1 − Brier score of the execution model on a test set (0.75 = coin flip on balanced data). */
export function executionAccuracy(model: ExecutionModel, test: LearningSample[]): number | null {
  if (test.length === 0) return null;
  const brier = mean(test.map((s) => (model.predict(s.features) - (s.success ? 1 : 0)) ** 2));
  return 1 - brier;
}

/** Share of predictions within max(5 bps, 25 %) of the realised slippage. */
export function slippageAccuracy(model: SlippageModel, test: LearningSample[]): number | null {
  const xs = test.filter((s) => s.realizedSlippageBps !== null);
  if (xs.length === 0) return null;
  const ok = xs.filter((s) => Math.abs(model.expectedBps(s.features) - (s.realizedSlippageBps as number)) <= Math.max(5, 0.25 * Math.abs(s.realizedSlippageBps as number)));
  return ok.length / xs.length;
}

/**
 * Share of LANDED trades whose actually paid fees were within 10 % (or 5 000 lamports) of the
 * prediction. (A reverted bundle pays nothing by design — that is not a fee prediction error.)
 */
export function feeAccuracy(test: LearningSample[]): number | null {
  const landed = test.filter((s) => s.success);
  if (landed.length === 0) return null;
  const ok = landed.filter((s) => Math.abs(s.actualFeesLamports - s.predictedFeesLamports) <= Math.max(5_000, 0.1 * s.predictedFeesLamports));
  return ok.length / landed.length;
}

export interface SetPerformance {
  n: number;
  netEur: number;
  expectancyEur: number;
  winRate: number;
  failureRate: number;
  maxDrawdownEur: number;
  pValue: number;
}

export function setPerformance(xs: LearningSample[]): SetPerformance {
  const net = xs.map((s) => (s.realizedNetLamports / 1e9) * s.solEur);
  const n = xs.length;
  return {
    n,
    netEur: net.reduce((a, b) => a + b, 0),
    expectancyEur: n ? mean(net) : 0,
    winRate: n ? net.filter((x) => x > 0).length / n : 0,
    failureRate: n ? xs.filter((s) => !s.success).length / n : 0,
    maxDrawdownEur: n ? maxDrawdown(net) : 0,
    pValue: n >= 2 ? tTestGreater(net, 0).pValue : 1,
  };
}

export interface ValidationReport {
  train: SetPerformance;
  validation: SetPerformance;
  oos: SetPerformance;
  walkForward: { fold: number; test: SetPerformance; executionAccuracy: number | null }[];
  executionAccuracy: number | null;
  slippageAccuracy: number | null;
  feeAccuracy: number | null;
  /** Models fitted on the training split and scored on validation+OOS agree across folds. */
  stable: boolean;
}

export function validate(samples: LearningSample[], splits: [number, number, number], folds: number): ValidationReport {
  const { train, validation, oos } = chronoSplit(samples, splits);
  const exec = new ExecutionModel();
  exec.fit(train);
  const slip = new SlippageModel();
  slip.fit(train);
  const holdout = [...validation, ...oos];
  const wf = walkForward(samples, folds).map((f, i) => {
    const m = new ExecutionModel();
    m.fit(f.train);
    return { fold: i + 1, test: setPerformance(f.test), executionAccuracy: executionAccuracy(m, f.test) };
  });
  const accs = wf.map((f) => f.executionAccuracy).filter((x): x is number => x !== null);
  const stable = accs.length >= 2 && Math.max(...accs) - Math.min(...accs) <= 0.15 && wf.filter((f) => f.test.expectancyEur > 0).length >= Math.ceil(wf.length * 0.75);
  return {
    train: setPerformance(train),
    validation: setPerformance(validation),
    oos: setPerformance(oos),
    walkForward: wf,
    executionAccuracy: executionAccuracy(exec, holdout),
    slippageAccuracy: slippageAccuracy(slip, holdout),
    feeAccuracy: feeAccuracy(holdout),
    stable,
  };
}
