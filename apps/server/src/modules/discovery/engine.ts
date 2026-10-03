import { describeCondition, type PerformanceStats } from "@multbot/shared";
import {
  benjaminiHochberg,
  deflatedSharpeRatio,
  kurtosis,
  mean,
  performance,
  skewness,
  spearman,
  tCdf,
  variance,
} from "../stats/stats.js";
import { derivedName, evalDerived, isDerivedName, type DerivedFeatureDef, type DerivedOp } from "../features/derived.js";
import type { Dataset } from "./dataset.js";
import { targetHorizonSec } from "./dataset.js";
import {
  atomKey,
  atomMask,
  atomToCondition,
  Bitset,
  columnQuantile,
  EvalScratch,
  evaluateMask,
  type Atom,
  type Evaluation,
} from "./recipes.js";

/**
 * Strategy discovery: searches conjunctions of conditions ("recipes") whose de-duplicated,
 * cost-adjusted forward returns are positive — and then tries hard to falsify them.
 *
 * Pipeline per target
 *   1. chronological split train | embargo | validation | embargo | holdout
 *   2. feature screening (Spearman on train) + derived combinations (A/B, A·B, A−B)
 *   3. atoms at train quantiles, beam search of conjunctions (every evaluation counted)
 *   4. Benjamini–Hochberg across ALL tested hypotheses
 *   5. validation (out-of-sample), walk-forward with re-fitted thresholds, deflated Sharpe
 *   6. holdout test (touched once, only by candidates that passed everything else)
 *   7. evidence: regime breakdown, near misses per condition, worst trades, cost share,
 *      and a list of reasons why the recipe might NOT work
 */

export interface DiscoveryConfig {
  targets: string[];
  maxConditions: number;
  minSamples: number;
  fdrAlpha: number;
  maxHypotheses: number;
  walkForwardFolds: number;
  beamWidth: number;
  atomPool: number;
  screenFeatures: number;
  derivedBase: number;
  /** Deflated-Sharpe probability required to not be flagged as possible overfit. */
  minDsr: number;
  /** Validation mean must retain at least this share of the train mean. */
  minOosRetention: number;
  /** Embargo between splits (ms) — avoids overlapping forward windows leaking across splits. */
  embargoMs: number;
}

export const DEFAULT_DISCOVERY: DiscoveryConfig = {
  targets: ["h:60", "h:300", "h:900", "tpsl:300:0.5:0.2", "tpsl:900:0.5:0.2", "tpsl:3600:1:0.35"],
  maxConditions: 3,
  minSamples: 200,
  fdrAlpha: 0.05,
  maxHypotheses: 20_000,
  walkForwardFolds: 4,
  beamWidth: 40,
  atomPool: 120,
  screenFeatures: 60,
  derivedBase: 10,
  minDsr: 0.9,
  minOosRetention: 0.25,
  embargoMs: 3_600_000,
};

export type Verdict = "survived" | "rejected";

export interface SplitStats {
  n: number;
  mean: number;
  median: number;
  winRate: number;
  pValue: number;
  worst: number;
  best: number;
  maxDrawdown: number;
  profitFactor: number;
  tailLoss: number;
}

export interface CandidateReport {
  target: string;
  horizonSec: number;
  atoms: Atom[];
  conditions: ReturnType<typeof atomToCondition>[];
  description: string[];
  derived: DerivedFeatureDef[];
  train: SplitStats;
  validation: SplitStats | null;
  holdout: SplitStats | null;
  walkForward: { folds: { n: number; mean: number; winRate: number }[]; positiveShare: number; mean: number } | null;
  multipleTesting: { hypothesesTested: number; pValue: number; qValue: number; fdrAlpha: number };
  overfit: { dsr: number; sharpeTrain: number; sharpeOos: number | null; oosRetention: number | null };
  regimes: { label: string; n: number; mean: number; winRate: number }[];
  nearMisses: { dropped: string; n: number; mean: number; delta: number }[];
  worstTrades: { mint: string; ts: number; ret: number }[];
  costShare: number | null;
  baselineMean: number;
  venues: string[];
  verdict: Verdict;
  rejectReason: string | null;
  whyItMightFail: string[];
  samplePeriod: { from: number; to: number };
}

export interface HypothesisRecord {
  target: string;
  conditions: ReturnType<typeof atomToCondition>[];
  nTrain: number;
  meanTrain: number;
  pValue: number;
  qValue: number;
  nTest: number | null;
  meanTest: number | null;
  walkForward: unknown;
  verdict: Verdict;
  rejectReason: string | null;
}

export interface DiscoveryResult {
  hypothesesTested: number;
  candidates: CandidateReport[];
  hypotheses: HypothesisRecord[];
  dataset: { n: number; from: number; to: number; features: number; mints: number };
  insufficientData: boolean;
  log: string[];
}

function toSplitStats(values: number[]): SplitStats {
  const p = performance(values);
  return {
    n: p.n,
    mean: p.mean,
    median: p.median,
    winRate: p.winRate,
    pValue: p.pValue,
    worst: p.worst,
    best: p.best,
    maxDrawdown: p.maxDrawdown,
    profitFactor: Number.isFinite(p.profitFactor) ? p.profitFactor : 999,
    tailLoss: p.tailLoss,
  };
}

interface Tested {
  atoms: Atom[];
  mask: Bitset;
  ev: Evaluation;
  pValue: number;
}

export class DiscoveryEngine {
  private readonly log: string[] = [];

  constructor(
    private readonly ds: Dataset,
    private readonly cfg: DiscoveryConfig = DEFAULT_DISCOVERY,
  ) {}

  private note(msg: string): void {
    this.log.push(msg);
  }

  run(): DiscoveryResult {
    const ds = this.ds;
    const result: DiscoveryResult = {
      hypothesesTested: 0,
      candidates: [],
      hypotheses: [],
      dataset: { n: ds.n, from: ds.period.from, to: ds.period.to, features: ds.features.size, mints: ds.mints.length },
      insufficientData: false,
      log: this.log,
    };
    if (ds.n < this.cfg.minSamples * 3) {
      result.insufficientData = true;
      this.note(`dataset too small: ${ds.n} rows < ${this.cfg.minSamples * 3}`);
      return result;
    }

    // 1. chronological splits with embargo
    const { train, val, test, trainVal } = this.splits();
    this.note(`splits: train=${train.count()} val=${val.count()} holdout=${test.count()}`);

    const scratch = new EvalScratch(ds.mints.length);
    const allTested: (Tested & { target: string })[] = [];
    const budgetPerTarget = Math.floor(this.cfg.maxHypotheses / this.cfg.targets.length);

    for (const target of this.cfg.targets) {
      if (!ds.targets.has(target)) continue;
      const y = ds.target(target);
      const cooldownMs = targetHorizonSec(target) * 1000;
      // 2. screening + derived features
      const pool = this.screen(target, train);
      const derived = this.addDerived(pool.filter((f) => !isDerivedName(f)).slice(0, this.cfg.derivedBase), target, train);
      const features = [...pool, ...derived.map((d) => d.name)];
      // 3. atoms
      const atoms = this.buildAtoms(features, train);
      const atomEval: Tested[] = [];
      const trainCount = train.count();
      for (const a of atoms) {
        const mask = atomMask(ds, a);
        const inTrain = mask.and(train);
        // a condition that (almost) always holds is not a condition
        if (inTrain.count() > 0.9 * trainCount) continue;
        const ev = evaluateMask(ds, inTrain, y, cooldownMs, scratch);
        if (ev.n < this.cfg.minSamples) continue;
        atomEval.push({ atoms: [a], mask, ev, pValue: 1 });
      }
      let tested = 0;
      const finalize = (t: Tested) => {
        t.pValue = t.ev.n > 1 && t.ev.std > 0 ? pFromT(t.ev.t, t.ev.n) : 1;
        tested++;
        allTested.push({ ...t, target });
      };
      atomEval.forEach(finalize);
      // extension pool: atoms with the best means
      const extension = [...atomEval].sort((a, b) => b.ev.mean - a.ev.mean).slice(0, this.cfg.atomPool);
      let beam = [...atomEval].sort((a, b) => b.ev.t - a.ev.t).slice(0, this.cfg.beamWidth);
      // 4. beam search over conjunctions
      const seen = new Set<string>(beam.map((b) => b.atoms.map(atomKey).sort().join("&")));
      for (let depth = 2; depth <= this.cfg.maxConditions && tested < budgetPerTarget; depth++) {
        const next: Tested[] = [];
        for (const b of beam) {
          const usedFeatures = new Set(b.atoms.map((a) => a.feature));
          for (const ext of extension) {
            const a = ext.atoms[0] as Atom;
            if (usedFeatures.has(a.feature)) continue;
            const atomsNew = [...b.atoms, a];
            const key = atomsNew.map(atomKey).sort().join("&");
            if (seen.has(key)) continue;
            seen.add(key);
            const mask = b.mask.and(ext.mask);
            const ev = evaluateMask(ds, mask.and(train), y, cooldownMs, scratch);
            if (ev.n < this.cfg.minSamples) continue;
            const t: Tested = { atoms: atomsNew, mask, ev, pValue: 1 };
            finalize(t);
            next.push(t);
            if (tested >= budgetPerTarget) break;
          }
          if (tested >= budgetPerTarget) break;
        }
        beam = next.sort((a, b) => b.ev.t - a.ev.t).slice(0, this.cfg.beamWidth);
        if (beam.length === 0) break;
      }
      this.note(`${target}: ${features.length} features (${derived.length} derived), ${atoms.length} atoms, ${tested} hypotheses`);
      this.derivedByTarget.set(target, derived);
    }

    result.hypothesesTested = allTested.length;
    if (allTested.length === 0) {
      this.note("no hypothesis reached the minimum sample size");
      result.insufficientData = true;
      return result;
    }

    // 5. multiple testing across everything that was tested
    const qValues = benjaminiHochberg(allTested.map((t) => t.pValue));
    const sharpes = allTested.map((t) => (t.ev.std > 0 ? t.ev.mean / t.ev.std : 0));
    const sharpeVar = variance(sharpes);
    const survivorsBh = allTested
      .map((t, i) => ({ t, q: qValues[i] as number }))
      .filter(({ t, q }) => q <= this.cfg.fdrAlpha && t.ev.mean > 0)
      .sort((a, b) => b.t.ev.t - a.t.ev.t);
    this.note(`${survivorsBh.length} hypotheses significant after Benjamini–Hochberg (FDR ${this.cfg.fdrAlpha})`);

    // de-duplicate near-identical candidates (same target, ≥80% overlapping matches)
    const chosen: { t: Tested & { target: string }; q: number }[] = [];
    for (const s of survivorsBh) {
      const redundant = chosen.some(
        (c) => c.t.target === s.t.target && overlap(c.t.mask.and(train), s.t.mask.and(train)) >= 0.8,
      );
      if (!redundant) chosen.push(s);
      if (chosen.length >= 30) break;
    }

    // record top hypotheses (best by t per target plus all BH survivors)
    const recordSet = new Set<Tested>();
    for (const s of survivorsBh.slice(0, 500)) recordSet.add(s.t);
    for (const t of [...allTested].sort((a, b) => b.ev.t - a.ev.t).slice(0, 500)) recordSet.add(t);

    for (const { t, q } of chosen) {
      const report = this.validate(t, q, allTested.length, sharpeVar, { train, val, test, trainVal }, scratch);
      result.candidates.push(report);
    }
    const candidateByKey = new Map(result.candidates.map((c) => [c.target + c.atoms.map(atomKey).sort().join("&"), c]));
    for (const t of recordSet) {
      const idx = allTested.indexOf(t as Tested & { target: string });
      const target = (t as Tested & { target: string }).target;
      const c = candidateByKey.get(target + t.atoms.map(atomKey).sort().join("&"));
      result.hypotheses.push({
        target,
        conditions: t.atoms.map(atomToCondition),
        nTrain: t.ev.n,
        meanTrain: t.ev.mean,
        pValue: t.pValue,
        qValue: qValues[idx] ?? 1,
        nTest: c?.holdout?.n ?? null,
        meanTest: c?.holdout?.mean ?? null,
        walkForward: c?.walkForward ?? null,
        verdict: c?.verdict ?? "rejected",
        rejectReason: c ? c.rejectReason : (qValues[idx] ?? 1) > this.cfg.fdrAlpha ? "NOT_SIGNIFICANT_AFTER_MULTIPLE_TESTING" : "REDUNDANT",
      });
    }
    this.note(`${result.candidates.filter((c) => c.verdict === "survived").length} recipes survived all checks`);
    return result;
  }

  private readonly derivedByTarget = new Map<string, DerivedFeatureDef[]>();

  private splits(): { train: Bitset; val: Bitset; test: Bitset; trainVal: Bitset } {
    const ds = this.ds;
    const { from, to } = ds.period;
    const span = to - from;
    const tTrain = from + span * 0.6;
    const tVal = from + span * 0.8;
    const e = Math.min(this.cfg.embargoMs, span * 0.02);
    const train = new Bitset(ds.n);
    const val = new Bitset(ds.n);
    const test = new Bitset(ds.n);
    const trainVal = new Bitset(ds.n);
    for (let i = 0; i < ds.n; i++) {
      const t = ds.ts[i] as number;
      if (t < tTrain - e) {
        train.set(i);
        trainVal.set(i);
      } else if (t >= tTrain && t < tVal - e) {
        val.set(i);
        trainVal.set(i);
      } else if (t >= tVal) {
        test.set(i);
      }
    }
    return { train, val, test, trainVal };
  }

  /** Top features by |Spearman| with the target on the training rows. */
  private screen(target: string, train: Bitset): string[] {
    const ds = this.ds;
    const y = ds.target(target);
    const idx: number[] = [];
    train.forEach((i) => {
      if ((y[i] as number) === (y[i] as number)) idx.push(i);
    });
    // subsample for speed
    const step = Math.max(1, Math.floor(idx.length / 20_000));
    const rows = idx.filter((_, k) => k % step === 0);
    const scored: { f: string; rho: number }[] = [];
    for (const [f, col] of ds.features) {
      if (isDerivedName(f)) continue; // derived columns of other targets are not re-screened
      const xs: number[] = [];
      const ys: number[] = [];
      for (const i of rows) {
        const v = col[i] as number;
        if (v === v) {
          xs.push(v);
          ys.push(y[i] as number);
        }
      }
      if (xs.length < this.cfg.minSamples) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of xs) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if (!(hi > lo)) continue; // constant on train → carries no information
      const rho = spearman(xs, ys);
      if (Number.isFinite(rho)) scored.push({ f, rho: Math.abs(rho) });
    }
    return scored.sort((a, b) => b.rho - a.rho).slice(0, this.cfg.screenFeatures).map((s) => s.f);
  }

  /** Pairwise combinations of the most informative features, kept if they beat both parents. */
  private addDerived(base: string[], target: string, train: Bitset): DerivedFeatureDef[] {
    const ds = this.ds;
    const y = ds.target(target);
    const out: DerivedFeatureDef[] = [];
    const rhoOf = (col: Float32Array): number => {
      const xs: number[] = [];
      const ys: number[] = [];
      let k = 0;
      train.forEach((i) => {
        if (k++ % 3 !== 0) return;
        const v = col[i] as number;
        const t = y[i] as number;
        if (v === v && t === t) {
          xs.push(v);
          ys.push(t);
        }
      });
      return xs.length >= this.cfg.minSamples ? Math.abs(spearman(xs, ys)) : 0;
    };
    const parentRho = new Map(base.map((f) => [f, rhoOf(ds.feature(f) as Float32Array)]));
    const ops: DerivedOp[] = ["ratio", "product", "diff"];
    for (let a = 0; a < base.length; a++) {
      for (let b = 0; b < base.length; b++) {
        if (a === b) continue;
        for (const op of ops) {
          if (op !== "ratio" && b < a) continue; // symmetric ops once
          const fa = base[a] as string;
          const fb = base[b] as string;
          const def: DerivedFeatureDef = { name: derivedName(op, [fa, fb]), op, args: [fa, fb] };
          if (ds.features.has(def.name)) continue;
          const col = new Float32Array(ds.n).fill(Number.NaN);
          const ca = ds.feature(fa) as Float32Array;
          const cb = ds.feature(fb) as Float32Array;
          for (let i = 0; i < ds.n; i++) {
            const v = evalDerived(def, { [fa]: ca[i] as number, [fb]: cb[i] as number });
            if (v !== undefined) col[i] = v;
          }
          const rho = rhoOf(col);
          if (rho > Math.max(parentRho.get(fa) ?? 0, parentRho.get(fb) ?? 0) * 1.1) {
            ds.addFeature(def.name, col);
            out.push(def);
          }
        }
      }
    }
    return out.slice(0, 20);
  }

  private buildAtoms(features: string[], train: Bitset): Atom[] {
    const atoms: Atom[] = [];
    const seen = new Set<string>();
    const push = (a: Atom) => {
      const k = atomKey(a);
      if (!seen.has(k)) {
        seen.add(k);
        atoms.push(a);
      }
    };
    for (const f of features) {
      if (f.startsWith("ev_") && f.endsWith("_age")) {
        for (const v of [30, 120, 600]) push({ feature: f, op: "lte", value: v, level: null });
        continue;
      }
      if (f.endsWith("__ctxz")) {
        for (const v of [2, 3]) push({ feature: f, op: "gte", value: v, level: null });
        push({ feature: f, op: "lte", value: -2, level: null });
      }
      for (const [q, op] of [
        [0.9, "gte"],
        [0.75, "gte"],
        [0.25, "lte"],
        [0.1, "lte"],
      ] as const) {
        const v = columnQuantile(this.ds, f, train, q);
        if (v !== null && Number.isFinite(v)) push({ feature: f, op, value: v, level: q });
      }
    }
    return atoms;
  }

  private statsFor(mask: Bitset, split: Bitset, target: string, scratch: EvalScratch): { stats: SplitStats; idx: number[]; values: number[] } {
    const y = this.ds.target(target);
    const ev = evaluateMask(this.ds, mask.and(split), y, targetHorizonSec(target) * 1000, scratch, true);
    const values = ev.indices.map((i) => y[i] as number);
    return { stats: toSplitStats(values), idx: ev.indices, values };
  }

  private validate(
    t: Tested & { target: string },
    qValue: number,
    trials: number,
    sharpeVar: number,
    s: { train: Bitset; val: Bitset; test: Bitset; trainVal: Bitset },
    scratch: EvalScratch,
  ): CandidateReport {
    const ds = this.ds;
    const target = t.target;
    const horizonSec = targetHorizonSec(target);
    const trainR = this.statsFor(t.mask, s.train, target, scratch);
    const valR = this.statsFor(t.mask, s.val, target, scratch);
    const why: string[] = [];
    let verdict: Verdict = "survived";
    let reject: string | null = null;
    const fail = (reason: string) => {
      if (verdict === "survived") {
        verdict = "rejected";
        reject = reason;
      }
    };

    // out-of-sample validation
    const oosRetention = trainR.stats.mean > 0 ? valR.stats.mean / trainR.stats.mean : null;
    if (valR.stats.n < Math.max(20, this.cfg.minSamples / 5)) fail("INSUFFICIENT_SAMPLES");
    else if (valR.stats.mean <= 0) fail("FAILED_OUT_OF_SAMPLE");
    else if ((oosRetention ?? 0) < this.cfg.minOosRetention) fail("FAILED_OUT_OF_SAMPLE");

    // walk-forward with re-fitted thresholds
    const wf = this.walkForward(t, s.trainVal, scratch);
    if (wf) {
      const valid = wf.folds.filter((f) => f.n >= 10);
      if (valid.length >= 2 && (wf.positiveShare < 0.6 || wf.mean <= 0)) fail("FAILED_WALK_FORWARD");
    }

    // deflated Sharpe on train+validation trades
    const tvValues = [...trainR.values, ...valR.values];
    const sd = Math.sqrt(variance(tvValues));
    const tvMean = mean(tvValues);
    const sharpe = sd > 0 ? tvMean / sd : tvMean > 0 ? Infinity : 0;
    // Expected maximum Sharpe of `trials` zero-skill strategies. The variance of a Sharpe estimate
    // under the null is ≈ 1/(n−1); the cross-trial variance is not used because many trials share
    // the same (possibly real) effect and would inflate the benchmark. `trials` counts every
    // evaluated hypothesis (conservative: correlated trials are counted as independent).
    const dsr = deflatedSharpeRatio({
      sharpe,
      n: tvValues.length,
      skew: skewness(tvValues),
      kurtosis: kurtosis(tvValues),
      trials,
      sharpeVariance: tvValues.length > 1 ? 1 / (tvValues.length - 1) : 1,
    });
    void sharpeVar;
    if (dsr < this.cfg.minDsr) fail("POSSIBLE_OVERFIT");

    // holdout: evaluated once, only for candidates that passed all previous gates
    let holdout: SplitStats | null = null;
    let testR: ReturnType<DiscoveryEngine["statsFor"]> | null = null;
    if (verdict === "survived") {
      testR = this.statsFor(t.mask, s.test, target, scratch);
      holdout = testR.stats;
      if (holdout.n < 10) {
        why.push(`Holdout enthält nur ${holdout.n} Trades — Aussagekraft gering.`);
      } else if (holdout.mean <= 0) {
        fail("FAILED_OUT_OF_SAMPLE");
      }
    }

    // evidence: regimes, near misses, worst trades, costs, baseline
    const oosIdx = [...valR.idx, ...(testR?.idx ?? [])];
    const y = ds.target(target);
    const regimes = new Map<string, number[]>();
    for (const i of oosIdx) {
      const label = ds.regimes[i] ?? "unknown";
      const arr = regimes.get(label) ?? [];
      arr.push(y[i] as number);
      regimes.set(label, arr);
    }
    const regimeStats = [...regimes.entries()]
      .map(([label, vals]) => ({ label, n: vals.length, mean: mean(vals), winRate: vals.filter((v) => v > 0).length / vals.length }))
      .sort((a, b) => b.n - a.n);
    const losingRegimes = regimeStats.filter((r) => r.n >= 10 && r.mean < 0);
    for (const r of losingRegimes) why.push(`Negativ im Marktregime "${r.label}" (${r.n} Trades, Ø ${(r.mean * 100).toFixed(1)}%).`);
    if (regimeStats.length > 0 && regimeStats.filter((r) => r.n >= 10).length === 1) {
      why.push("Nur in einem einzigen Marktregime beobachtet — Verhalten in anderen Regimen unbekannt.");
    }

    const nearMisses: CandidateReport["nearMisses"] = [];
    if (t.atoms.length > 1) {
      for (let k = 0; k < t.atoms.length; k++) {
        let m = Bitset.range(ds.n, 0, ds.n);
        t.atoms.forEach((a, j) => {
          if (j !== k) m = m.and(atomMask(ds, a));
        });
        const full = t.mask;
        // rows matching all other conditions but NOT this one
        const miss = new Bitset(ds.n);
        m.and(s.trainVal).forEach((i) => {
          if (!full.has(i)) miss.set(i);
        });
        const ev = evaluateMask(ds, miss, y, horizonSec * 1000, scratch);
        const cond = describeCondition(atomToCondition(t.atoms[k] as Atom));
        nearMisses.push({ dropped: cond, n: ev.n, mean: ev.mean, delta: mean(tvValues) - ev.mean });
        if (ev.n >= 30 && ev.mean > mean(tvValues) * 0.8) why.push(`Bedingung "${cond}" trägt kaum zum Ergebnis bei (ohne sie ähnliche Rendite).`);
      }
    }
    const worstTrades = [...oosIdx]
      .sort((a, b) => (y[a] as number) - (y[b] as number))
      .slice(0, 10)
      .map((i) => ({ mint: ds.mints[ds.mintIdx[i] as number] as string, ts: ds.ts[i] as number, ret: y[i] as number }));

    let costShare: number | null = null;
    const g = ds.grossTargets.get(target);
    if (g) {
      const tvIdx = [...trainR.idx, ...valR.idx];
      const gross = mean(tvIdx.map((i) => g[i] as number).filter((v) => v === v));
      const net = mean(tvValues);
      if (gross > 0) costShare = Math.max(0, (gross - net) / gross);
      if (costShare !== null && costShare > 0.6) why.push(`Kosten verbrauchen ${(costShare * 100).toFixed(0)}% des Brutto-Edges — empfindlich gegenüber höheren Gebühren/Slippage.`);
    }
    const baselineVals: number[] = [];
    const baseEval = evaluateMask(ds, s.val, y, horizonSec * 1000, scratch, true);
    for (const i of baseEval.indices) baselineVals.push(y[i] as number);
    const baselineMean = mean(baselineVals);

    const tv = performance(tvValues);
    if (tv.median < 0 && tv.mean > 0) why.push("Median negativ bei positivem Mittelwert: Ergebnis hängt von wenigen Ausreißern ab.");
    if (tv.tailLoss < -0.3) why.push(`Hoher Tail-Loss: die schlechtesten 5% verlieren im Schnitt ${(tv.tailLoss * -100).toFixed(0)}%.`);
    if (dsr < 0.97) why.push(`Deflated Sharpe nur ${dsr.toFixed(2)} bei ${trials} getesteten Hypothesen.`);
    if (oosRetention !== null && oosRetention < 0.6) why.push(`Out-of-Sample nur ${(oosRetention * 100).toFixed(0)}% der Trainings-Rendite.`);
    if (wf && wf.positiveShare < 1) why.push(`Walk-forward: ${(wf.positiveShare * 100).toFixed(0)}% der Folds positiv.`);
    why.push("Stichprobe stammt aus einem begrenzten Zeitraum; Memecoin-Märkte ändern sich schnell (Strategy Decay möglich).");
    why.push("Die Ausführung ist simuliert (Verzögerung, Slippage, MEV-Aufschlag); echte Fills können abweichen.");

    const venues = [...new Set([...trainR.idx, ...valR.idx].map((i) => ds.venues[i] as string))];
    const derived = (this.derivedByTarget.get(target) ?? []).filter((d) => t.atoms.some((a) => a.feature === d.name));
    return {
      target,
      horizonSec,
      atoms: t.atoms,
      conditions: t.atoms.map(atomToCondition),
      description: t.atoms.map((a) => describeCondition(atomToCondition(a))),
      derived,
      train: trainR.stats,
      validation: valR.stats,
      holdout,
      walkForward: wf,
      multipleTesting: { hypothesesTested: trials, pValue: t.pValue, qValue, fdrAlpha: this.cfg.fdrAlpha },
      overfit: { dsr, sharpeTrain: Number.isFinite(sharpe) ? sharpe : 99, sharpeOos: valR.stats.n > 1 ? sharpeOf(valR.values) : null, oosRetention },
      regimes: regimeStats,
      nearMisses,
      worstTrades,
      costShare,
      baselineMean,
      venues,
      verdict,
      rejectReason: reject,
      whyItMightFail: why,
      samplePeriod: this.ds.period,
    };
  }

  /** Walk-forward: thresholds re-fitted on all data before each fold, evaluated on the fold. */
  private walkForward(t: Tested & { target: string }, trainVal: Bitset, scratch: EvalScratch): CandidateReport["walkForward"] {
    const ds = this.ds;
    const idx: number[] = [];
    trainVal.forEach((i) => idx.push(i));
    const k = this.cfg.walkForwardFolds;
    if (idx.length < k * 20) return null;
    const y = ds.target(t.target);
    const folds: { n: number; mean: number; winRate: number }[] = [];
    const size = Math.floor(idx.length / k);
    for (let f = 1; f < k; f++) {
      const before = Bitset.range(ds.n, 0, idx[f * size] as number);
      const foldMask = Bitset.range(ds.n, idx[f * size] as number, (idx[Math.min(idx.length - 1, (f + 1) * size - 1)] as number) + 1).and(trainVal);
      let mask = Bitset.range(ds.n, 0, ds.n);
      for (const a of t.atoms) {
        const value = a.level !== null ? columnQuantile(ds, a.feature, before, a.level) : a.value;
        if (value === null) {
          mask = new Bitset(ds.n);
          break;
        }
        mask = mask.and(atomMask(ds, a, value));
      }
      const ev = evaluateMask(ds, mask.and(foldMask), y, targetHorizonSec(t.target) * 1000, scratch);
      folds.push({ n: ev.n, mean: ev.mean, winRate: ev.winRate });
    }
    const valid = folds.filter((f) => f.n >= 10);
    const total = valid.reduce((s, f) => s + f.n, 0);
    return {
      folds,
      positiveShare: valid.length > 0 ? valid.filter((f) => f.mean > 0).length / valid.length : 0,
      mean: total > 0 ? valid.reduce((s, f) => s + f.mean * f.n, 0) / total : 0,
    };
  }
}

/** Jaccard similarity of two match sets (a subset with a very different size is NOT redundant). */
function overlap(a: Bitset, b: Bitset): number {
  const inter = a.and(b).count();
  const union = a.count() + b.count() - inter;
  return union > 0 ? inter / union : 0;
}

function sharpeOf(values: number[]): number {
  const sd = Math.sqrt(variance(values));
  return sd > 0 ? mean(values) / sd : 0;
}

function pFromT(t: number, n: number): number {
  // one-sided p-value for mean > 0
  return tTestFromStat(t, n - 1);
}

function tTestFromStat(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 0 : 1;
  return 1 - tCdf(t, df);
}

export type { PerformanceStats };
