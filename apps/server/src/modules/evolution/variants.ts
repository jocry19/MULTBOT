import { REGIME_DIMENSIONS, describeCondition, strategySpecSchema, type Condition, type RegimeLevel, type StrategySpec } from "@multbot/shared";
import { allTargets, type Dataset } from "../discovery/dataset.js";
import { Bitset, EvalScratch, evaluateMask, type Evaluation } from "../discovery/recipes.js";
import { evalDerived, isDerivedName, parseDerivedName } from "../features/derived.js";
import { OUTCOME_HORIZONS_SEC, TPSL_HORIZONS_SEC, TP_LEVELS, SL_LEVELS, tpslKey } from "../research/outcomes.js";
import { median, tTestGreater, welchGreater } from "../stats/stats.js";

/**
 * Strategy evolution: propose ONE improved variant of an existing strategy.
 *
 * Honesty rules:
 *  - every mutation is scored on the older part of the data only (train); the single best variant
 *    is then confirmed on the newest part (holdout), which played no role in choosing it
 *  - scores are net returns after all modelled costs, with per-token cooldown de-duplication
 *  - a proposal is only a *challenger*: it still has to pass a causal backtest and beat the current
 *    version in paper trading on the same live period before it can replace it
 */

export type MutationKind = "exit" | "threshold" | "regime_filter" | "drop_condition";

export interface Variant {
  kind: MutationKind;
  /** minor = same structure, different parameters (1.x); major = structural change (x.0). */
  bump: "minor" | "major";
  spec: StrategySpec;
  target: string;
  summary: string;
}

export interface EvalSummary {
  n: number;
  mean: number;
  median: number;
  winRate: number;
}

export interface Proposal {
  variant: Variant;
  parent: { target: string; train: EvalSummary; holdout: EvalSummary };
  candidate: { train: EvalSummary; holdout: EvalSummary };
  variantsTried: number;
  /** One-sided p-value that the candidate's holdout mean net return is > 0. */
  holdoutPValue: number;
  /** One-sided Welch p-value that the candidate beats the parent on the holdout. */
  improvementPValue: number;
  split: { trainFrom: number; trainTo: number; holdoutFrom: number; holdoutTo: number };
}

export interface EvolutionConfig {
  trainShare: number;
  minTrainN: number;
  minHoldoutN: number;
  /** Max p-value for "holdout mean > 0". */
  maxHoldoutP: number;
  /** Max p-value for "candidate better than parent on holdout". */
  maxImprovementP: number;
  /** Regime labels the learning engine flagged as weak for this strategy (prioritised filters). */
  weakRegimes?: string[];
}

export const DEFAULT_EVOLUTION: EvolutionConfig = {
  trainShare: 0.7,
  minTrainN: 30,
  minHoldoutN: 20,
  maxHoldoutP: 0.1,
  maxImprovementP: 0.2,
};

const LEVELS: RegimeLevel[] = ["low", "normal", "high", "extreme"];
const LEVEL_VALUE: Record<RegimeLevel, number> = { low: 0, normal: 1, high: 2, extreme: 3 };
const THRESHOLD_SHIFTS = [-0.1, -0.05, 0.05, 0.1];

/** The research target (label) a spec corresponds to, or null if it cannot be evaluated offline. */
export function specTarget(spec: StrategySpec): string | null {
  const targets = new Set(allTargets());
  const p = spec.params?.target;
  if (typeof p === "string" && targets.has(p)) return p;
  const e = spec.exit;
  if (e.takeProfitPct !== undefined && e.stopLossPct !== undefined) {
    const t = `tpsl:${tpslKey(e.maxHoldSec, e.takeProfitPct, e.stopLossPct)}`;
    return targets.has(t) ? t : null;
  }
  const h = `h:${e.maxHoldSec}`;
  return targets.has(h) ? h : null;
}

/** Spec with the exit/horizon of another research target. */
export function withTarget(spec: StrategySpec, target: string): StrategySpec {
  const [kind, h, tp, sl] = target.split(":");
  const horizonSec = Number(h);
  const cooldownFollowsHorizon = spec.entry.cooldownSec === spec.horizonSec;
  const { takeProfitPct: _tp, stopLossPct: _sl, ...rest } = spec.exit;
  const exit = kind === "tpsl" ? { ...rest, takeProfitPct: Number(tp), stopLossPct: Number(sl), maxHoldSec: horizonSec } : { ...rest, maxHoldSec: horizonSec };
  return strategySpecSchema.parse({
    ...spec,
    entry: { ...spec.entry, cooldownSec: cooldownFollowsHorizon ? horizonSec : spec.entry.cooldownSec },
    exit,
    horizonSec,
    params: { ...spec.params, target },
  });
}

/** Feature column, computing derived combination features on demand. */
export function column(ds: Dataset, name: string): Float32Array | undefined {
  const existing = ds.feature(name);
  if (existing) return existing;
  if (!isDerivedName(name)) return undefined;
  const def = parseDerivedName(name);
  if (!def) return undefined;
  const cols = def.args.map((a) => ds.feature(a));
  if (cols.some((c) => c === undefined)) return undefined;
  const out = new Float32Array(ds.n).fill(Number.NaN);
  const f: Record<string, number> = {};
  for (let i = 0; i < ds.n; i++) {
    def.args.forEach((a, k) => (f[a] = (cols[k] as Float32Array)[i] as number));
    const v = evalDerived(def, f);
    if (v !== undefined) out[i] = v;
  }
  ds.addFeature(name, out);
  return out;
}

function test(v: number, c: Condition): boolean {
  if (c.kind !== "feature") return false;
  switch (c.op) {
    case "gt":
      return c.value !== undefined && v > c.value;
    case "gte":
      return c.value !== undefined && v >= c.value;
    case "lt":
      return c.value !== undefined && v < c.value;
    case "lte":
      return c.value !== undefined && v <= c.value;
    case "between":
      return c.low !== undefined && c.high !== undefined && v >= c.low && v <= c.high;
  }
}

/** Rows where a condition holds — identical semantics to `conditionHolds` in live evaluation. */
export function conditionMask(ds: Dataset, c: Condition): Bitset {
  const b = new Bitset(ds.n);
  const name = c.kind === "feature" ? c.feature : c.kind === "event" ? `ev_${c.eventType}_age` : `mkt_${c.dimension}_level`;
  const col = column(ds, name);
  if (!col) return b;
  const levels = c.kind === "regime" ? new Set(c.levels.map((l) => LEVEL_VALUE[l])) : null;
  for (let i = 0; i < ds.n; i++) {
    const v = col[i] as number;
    if (v !== v) continue;
    const ok = c.kind === "feature" ? test(v, c) : c.kind === "event" ? v <= c.withinSec : (levels as Set<number>).has(v);
    if (ok) b.set(i);
  }
  return b;
}

export function universeMask(ds: Dataset, spec: StrategySpec): Bitset {
  const b = new Bitset(ds.n);
  const venues = new Set<string>(spec.universe.venues);
  const lo = spec.universe.minAgeSec ?? -Infinity;
  const hi = spec.universe.maxAgeSec ?? Infinity;
  for (let i = 0; i < ds.n; i++) {
    const age = ds.ageSec[i] as number;
    if (venues.has(ds.venues[i] as string) && age >= lo && age <= hi) b.set(i);
  }
  return b;
}

export function specMask(ds: Dataset, spec: StrategySpec, universe = universeMask(ds, spec)): Bitset {
  const m = universe.clone();
  for (const c of spec.conditions) m.andInPlace(conditionMask(ds, c));
  return m;
}

function summarize(e: Evaluation, target: Float32Array): EvalSummary {
  return { n: e.n, mean: e.mean, median: median(e.indices.map((i) => target[i] as number)), winRate: e.winRate };
}

function quantileOf(values: Float32Array, rows: Bitset, v: number): number | null {
  let below = 0;
  let total = 0;
  rows.forEach((i) => {
    const x = values[i] as number;
    if (x !== x) return;
    total++;
    if (x < v) below++;
  });
  return total >= 20 ? below / total : null;
}

function valueAtQuantile(values: Float32Array, rows: Bitset, q: number): number | null {
  const xs: number[] = [];
  rows.forEach((i) => {
    const x = values[i] as number;
    if (x === x) xs.push(x);
  });
  if (xs.length < 20) return null;
  xs.sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))] as number;
}

/** All mutations of a spec (candidates are scored later; nothing here looks at outcomes). */
export function generateVariants(ds: Dataset, spec: StrategySpec, trainRows: Bitset, weakRegimes: string[] = []): Variant[] {
  const out: Variant[] = [];
  const parentTarget = specTarget(spec);
  if (!parentTarget || !ds.targets.has(parentTarget)) return out;

  // 1) exit variants: other take-profit / stop-loss / holding-time combinations
  const exitTargets = [
    ...OUTCOME_HORIZONS_SEC.map((h) => `h:${h}`),
    ...TPSL_HORIZONS_SEC.flatMap((h) => TP_LEVELS.flatMap((tp) => SL_LEVELS.map((sl) => `tpsl:${tpslKey(h, tp, sl)}`))),
  ].filter((t) => t !== parentTarget && ds.targets.has(t));
  for (const t of exitTargets) out.push({ kind: "exit", bump: "minor", spec: withTarget(spec, t), target: t, summary: `Exit ${describeTarget(parentTarget)} → ${describeTarget(t)}` });

  // 2) threshold re-fit: shift each numeric threshold by ±5 / ±10 quantile points (train rows only)
  spec.conditions.forEach((c, idx) => {
    if (c.kind !== "feature" || c.value === undefined || c.op === "between") return;
    const col = column(ds, c.feature);
    if (!col) return;
    const q = quantileOf(col, trainRows, c.value);
    if (q === null) return;
    for (const d of THRESHOLD_SHIFTS) {
      const nq = Math.min(0.99, Math.max(0.01, q + d));
      const v = valueAtQuantile(col, trainRows, nq);
      if (v === null || v === c.value) continue;
      const cond: Condition = { ...c, value: Number(v.toPrecision(6)) };
      const conditions = spec.conditions.map((x, j) => (j === idx ? cond : x));
      out.push({
        kind: "threshold",
        bump: "minor",
        spec: strategySpecSchema.parse({ ...spec, conditions }),
        target: parentTarget,
        summary: `Schwelle ${describeCondition(c)} → ${describeCondition(cond)}`,
      });
    }
  });

  // 3) regime filters: skip one level of one market-regime dimension (weak regimes from learning first)
  const existingDims = new Set(spec.conditions.filter((c) => c.kind === "regime").map((c) => (c as { dimension: string }).dimension));
  const dims = [...REGIME_DIMENSIONS].filter((d) => !existingDims.has(d));
  const prioritized = dims.sort((a, b) => Number(weakRegimes.some((w) => w.includes(b))) - Number(weakRegimes.some((w) => w.includes(a))));
  for (const dim of prioritized) {
    for (const skip of LEVELS) {
      const cond: Condition = { kind: "regime", dimension: dim, levels: LEVELS.filter((l) => l !== skip) };
      out.push({
        kind: "regime_filter",
        bump: "major",
        spec: strategySpecSchema.parse({ ...spec, conditions: [...spec.conditions, cond] }),
        target: parentTarget,
        summary: `Nicht handeln bei ${dim} = ${skip}`,
      });
    }
  }

  // 4) simplification: drop one condition (fewer conditions = less overfitting risk)
  if (spec.conditions.length >= 2) {
    spec.conditions.forEach((c, idx) => {
      out.push({
        kind: "drop_condition",
        bump: "major",
        spec: strategySpecSchema.parse({ ...spec, conditions: spec.conditions.filter((_, j) => j !== idx) }),
        target: parentTarget,
        summary: `Bedingung entfernt: ${describeCondition(c)}`,
      });
    });
  }
  return out;
}

export function describeTarget(t: string): string {
  const [kind, h, tp, sl] = t.split(":");
  const hold = Number(h) >= 60 ? `${Math.round(Number(h) / 60)} min` : `${h} s`;
  return kind === "tpsl" ? `TP +${Math.round(Number(tp) * 100)}% / SL −${Math.round(Number(sl) * 100)}% / max ${hold}` : `Halten ${hold}`;
}

/**
 * Propose the best variant of `spec`, or null when no variant is convincingly better.
 * Selection uses the train part only; the holdout is used exactly once, for the chosen variant.
 */
export function proposeVariant(ds: Dataset, spec: StrategySpec, cfg: EvolutionConfig = DEFAULT_EVOLUTION): Proposal | null {
  const parentTarget = specTarget(spec);
  if (!parentTarget || !ds.targets.has(parentTarget) || ds.n < 100) return null;

  // chronological split with an embargo of the longest label horizon (no overlapping outcomes)
  const cut = Math.floor(ds.n * cfg.trainShare);
  const cutTs = ds.ts[cut] as number;
  const embargoMs = 3600_000;
  let holdStart = cut;
  while (holdStart < ds.n && (ds.ts[holdStart] as number) < cutTs + embargoMs) holdStart++;
  const train = Bitset.range(ds.n, 0, cut);
  const holdout = Bitset.range(ds.n, holdStart, ds.n);
  if (ds.n - holdStart < 50) return null;

  const scratch = new EvalScratch(ds.mints.length);
  const cooldownMs = (s: StrategySpec) => s.entry.cooldownSec * 1000;
  const evalOn = (s: StrategySpec, target: string, rows: Bitset, mask?: Bitset) =>
    evaluateMask(ds, (mask ?? specMask(ds, s)).and(rows), ds.target(target), cooldownMs(s), scratch, true);

  const parentMask = specMask(ds, spec);
  const parentTrain = evalOn(spec, parentTarget, train, parentMask);
  const parentHold = evalOn(spec, parentTarget, holdout, parentMask);

  const variants = generateVariants(ds, spec, train, cfg.weakRegimes);
  let best: { v: Variant; e: Evaluation; mask: Bitset } | null = null;
  for (const v of variants) {
    const mask = v.kind === "exit" ? parentMask : specMask(ds, v.spec);
    const e = evalOn(v.spec, v.target, train, mask);
    if (e.n < cfg.minTrainN) continue;
    // must beat the parent on train, and by a margin that is not just noise of the parent estimate
    const margin = parentTrain.n > 1 ? parentTrain.std / Math.sqrt(parentTrain.n) : 0;
    if (e.mean <= parentTrain.mean + 0.5 * margin) continue;
    if (!best || e.mean > best.e.mean) best = { v, e, mask };
  }
  if (!best) return null;

  const candHold = evalOn(best.v.spec, best.v.target, holdout, best.mask);
  if (candHold.n < cfg.minHoldoutN) return null;
  const candHoldVals = candHold.indices.map((i) => ds.target(best.v.target)[i] as number);
  const parentHoldVals = parentHold.indices.map((i) => ds.target(parentTarget)[i] as number);
  const holdoutPValue = tTestGreater(candHoldVals).pValue;
  const improvementPValue = parentHoldVals.length >= 2 ? welchGreater(candHoldVals, parentHoldVals).pValue : holdoutPValue;
  if (candHold.mean <= 0 || holdoutPValue > cfg.maxHoldoutP) return null;
  if (parentHold.n >= cfg.minHoldoutN && (candHold.mean <= parentHold.mean || improvementPValue > cfg.maxImprovementP)) return null;

  return {
    variant: best.v,
    parent: { target: parentTarget, train: summarize(parentTrain, ds.target(parentTarget)), holdout: summarize(parentHold, ds.target(parentTarget)) },
    candidate: { train: summarize(best.e, ds.target(best.v.target)), holdout: summarize(candHold, ds.target(best.v.target)) },
    variantsTried: variants.length,
    holdoutPValue,
    improvementPValue,
    split: { trainFrom: ds.ts[0] as number, trainTo: ds.ts[cut - 1] as number, holdoutFrom: ds.ts[holdStart] as number, holdoutTo: ds.ts[ds.n - 1] as number },
  };
}
