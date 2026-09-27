import type { Condition, RegimeLevel, StrategySpec } from "@multbot/shared";
import type { FeatureVector } from "../features/types.js";

/**
 * Pure evaluation of strategy specs against a feature vector — used identically by backtests,
 * paper trading and live trading. Missing features never satisfy a condition.
 */

const LEVEL_VALUE: Record<RegimeLevel, number> = { low: 0, normal: 1, high: 2, extreme: 3 };

export function conditionHolds(c: Condition, f: FeatureVector): boolean {
  switch (c.kind) {
    case "feature": {
      const v = f[c.feature];
      if (v === undefined || !Number.isFinite(v)) return false;
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
      return false;
    }
    case "event": {
      const age = f[`ev_${c.eventType}_age`];
      return age !== undefined && age <= c.withinSec;
    }
    case "regime": {
      const v = f[`mkt_${c.dimension}_level`];
      return v !== undefined && c.levels.some((l) => LEVEL_VALUE[l] === v);
    }
  }
}

export interface MatchResult {
  matched: boolean;
  /** Per condition: satisfied or not (for explanations and "similarity"). */
  details: { condition: Condition; holds: boolean }[];
  /** Share of satisfied conditions (current similarity to the recipe). */
  similarity: number;
}

export function matchSpec(spec: StrategySpec, f: FeatureVector, venue: "pump_curve" | "pump_amm", ageSec: number): MatchResult {
  const details = spec.conditions.map((condition) => ({ condition, holds: conditionHolds(condition, f) }));
  const inUniverse =
    spec.universe.venues.includes(venue) &&
    (spec.universe.minAgeSec === undefined || ageSec >= spec.universe.minAgeSec) &&
    (spec.universe.maxAgeSec === undefined || ageSec <= spec.universe.maxAgeSec);
  const satisfied = details.filter((d) => d.holds).length;
  return {
    matched: inUniverse && details.every((d) => d.holds),
    details,
    similarity: details.length > 0 ? satisfied / details.length : inUniverse ? 1 : 0,
  };
}

/** Any invalidation condition true → exit signal. */
export function invalidated(spec: StrategySpec, f: FeatureVector): Condition | null {
  for (const c of spec.exit.invalidation) if (conditionHolds(c, f)) return c;
  return null;
}
