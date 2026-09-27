import { z } from "zod";
import { REGIME_DIMENSIONS } from "./enums.js";

/**
 * Strategy specification ("recipe").
 *
 * Strategies are data, not code: the discovery engine emits specs, the backtester/paper/live engines
 * interpret them. Code-defined strategy families can plug in via `family` + `params`.
 *
 * Feature names refer to the FeatureEngine registry (e.g. "buy_ratio_60s", "volume_60s__ctxz").
 */

export const conditionOpSchema = z.enum(["gt", "gte", "lt", "lte", "between"]);
export type ConditionOp = z.infer<typeof conditionOpSchema>;

export const featureConditionSchema = z.object({
  kind: z.literal("feature"),
  feature: z.string().min(1),
  op: conditionOpSchema,
  value: z.number().optional(),
  low: z.number().optional(),
  high: z.number().optional(),
});
export type FeatureCondition = z.infer<typeof featureConditionSchema>;

export const eventConditionSchema = z.object({
  kind: z.literal("event"),
  eventType: z.string().min(1),
  /** The event must have been detected (and be available) within this many seconds before the decision. */
  withinSec: z.number().int().positive(),
});
export type EventCondition = z.infer<typeof eventConditionSchema>;

export const regimeConditionSchema = z.object({
  kind: z.literal("regime"),
  dimension: z.enum(REGIME_DIMENSIONS),
  levels: z.array(z.enum(["low", "normal", "high", "extreme"])).min(1),
});
export type RegimeCondition = z.infer<typeof regimeConditionSchema>;

export const conditionSchema = z.discriminatedUnion("kind", [
  featureConditionSchema,
  eventConditionSchema,
  regimeConditionSchema,
]);
export type Condition = z.infer<typeof conditionSchema>;

export const exitSpecSchema = z.object({
  /** +0.25 = take profit at +25% net of the entry price. */
  takeProfitPct: z.number().positive().optional(),
  /** 0.15 = stop at −15%. */
  stopLossPct: z.number().positive().max(1).optional(),
  trailingStopPct: z.number().positive().max(1).optional(),
  maxHoldSec: z.number().int().positive(),
  /** Exit when any of these conditions becomes true (signal invalidation). */
  invalidation: z.array(conditionSchema).default([]),
  /** Exit when the analogue-based expected value of holding turns negative. */
  expectedValueExit: z.boolean().default(false),
});
export type ExitSpec = z.infer<typeof exitSpecSchema>;

export const strategySpecSchema = z.object({
  family: z.string().min(1),
  universe: z.object({
    venues: z.array(z.enum(["pump_curve", "pump_amm"])).min(1),
    minAgeSec: z.number().int().min(0).optional(),
    maxAgeSec: z.number().int().positive().optional(),
  }),
  conditions: z.array(conditionSchema),
  entry: z.object({
    /** Do not re-enter the same token within this many seconds. */
    cooldownSec: z.number().int().min(0),
    maxSlippageBps: z.number().int().positive().optional(),
  }),
  exit: exitSpecSchema,
  /** Outcome horizon the recipe was discovered/labelled on. */
  horizonSec: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type StrategySpec = z.infer<typeof strategySpecSchema>;

export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case "feature": {
      const fmt = (v: number | undefined) => (v === undefined ? "?" : Number(v.toPrecision(4)).toString());
      if (c.op === "between") return `${c.feature} ∈ [${fmt(c.low)}, ${fmt(c.high)}]`;
      const sym = { gt: ">", gte: "≥", lt: "<", lte: "≤" }[c.op];
      return `${c.feature} ${sym} ${fmt(c.value)}`;
    }
    case "event":
      return `event ${c.eventType} within ${c.withinSec}s`;
    case "regime":
      return `regime.${c.dimension} ∈ {${c.levels.join(", ")}}`;
  }
}

/** Statistical summary of a set of net trade results (SOL or returns). */
export interface PerformanceStats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  mean: number;
  median: number;
  std: number;
  sum: number;
  best: number;
  worst: number;
  p05: number;
  p95: number;
  profitFactor: number;
  /** Mean of wins * winRate − mean loss * lossRate; equals mean for net results. */
  expectancy: number;
  maxDrawdown: number;
  tStat: number;
  /** One-sided p-value for mean > 0. */
  pValue: number;
  /** Average of the worst 5% of outcomes (expected shortfall / tail loss). */
  tailLoss: number;
}
