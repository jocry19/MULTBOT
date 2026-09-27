import { z } from "zod";

/**
 * User-facing settings (Settings page). Stored in the database with a full audit trail and
 * validated on every change. Secrets never live here — only in the environment.
 *
 * Two kinds of parameters:
 *   capital/risk   hard limits set by the user. The system may LOWER effective risk on its own
 *                  (downgrades, breakers) but never raise these values.
 *   strategy       thresholds the learning engine may tune (versioned, see strategy_versions).
 */

const eur = z.number().min(0).max(1_000_000);
const bpsSchema = z.number().min(0).max(10_000);

export const capitalSettingsSchema = z.object({
  startingCapitalEur: eur,
  /** Capital that must always remain untouched in the wallet. */
  reserveCapitalEur: eur,
  /** Absolute maximum per trade, whatever level or scaling says. */
  maxTradeEur: z.number().positive().max(100_000),
  maxConcurrentTrades: z.number().int().min(1).max(10),
  /** Virtual capital for paper trading (never mixed with the real wallet). */
  paperCapitalEur: z.number().positive().max(1_000_000),
});

export const riskSettingsSchema = z.object({
  maxLossPerTradeEur: eur,
  dailyLossLimitEur: eur,
  maxConsecutiveFailures: z.number().int().min(1).max(100),
  maxSlippageBps: bpsSchema,
  maxPriceImpactBps: bpsSchema,
  maxPriorityFeeLamports: z.number().int().min(0).max(100_000_000),
  maxJitoTipLamports: z.number().int().min(1_000).max(100_000_000),
  /** Jito tip may use at most this share of the expected gross profit. */
  maxJitoTipShareOfProfit: z.number().min(0).max(1),
  /** Non-atomic routes (two separate transactions) are rejected unless explicitly allowed. */
  requireAtomic: z.boolean(),
  /** Extra safety margin (bps) required for non-atomic routes if they are allowed. */
  nonAtomicExtraBufferBps: bpsSchema,
  tokenAllowlist: z.array(z.string()),
  tokenDenylist: z.array(z.string()),
  /** Current live level (1 … 4). Raised only by the user; lowered automatically on bad performance. */
  liveLevel: z.number().int().min(1).max(4),
  /** Maximum trade size per live level (EUR). */
  liveLevelMaxTradeEur: z.tuple([z.number().positive(), z.number().positive(), z.number().positive(), z.number().positive()]),
  emergencyStop: z.boolean(),
});

export const strategySettingsSchema = z.object({
  directEnabled: z.boolean(),
  triangularEnabled: z.boolean(),
  /** Trade sizes evaluated for every opportunity (EUR). */
  tradeSizesEur: z.array(z.number().positive()).min(1).max(40),
  /** Pool-state screening: minimum fee-adjusted mid spread before firm quotes are requested. */
  screenMinSpreadBps: bpsSchema,
  maxQuoteAgeMs: z.number().int().min(50).max(60_000),
  minNetProfitEur: z.number().min(0).max(1_000),
  minNetProfitPercent: z.number().min(0).max(100),
  minExecutionProbability: z.number().min(0).max(1),
  /** Base safety buffer (bps of size); the learned slippage uncertainty is added on top. */
  safetyBufferBps: bpsSchema,
  /** Slippage tolerance of the first leg (the second leg's minimum output enforces profitability). */
  legSlippageBps: bpsSchema,
  priorityFeePercentile: z.number().min(0).max(100),
  jitoTipPercentile: z.number().min(0).max(100),
  useJito: z.boolean(),
});

export const scannerSettingsSchema = z.object({
  poolPollMs: z.number().int().min(250).max(60_000),
  minPoolTvlUsd: z.number().min(0),
  maxPoolsPerTokenPerDex: z.number().int().min(1).max(10),
  poolRefreshMin: z.number().int().min(1).max(1440),
  /** Candidates verified with firm quotes per minute (bounded by the Jupiter plan). */
  maxCandidatesPerMinute: z.number().int().min(1).max(600),
  maxTriangularSwaps: z.number().int().min(3).max(4),
});

export const paperSettingsSchema = z.object({
  /** Latency used for shadow execution until the learned latency model has enough samples. */
  defaultLatencyMs: z.number().int().min(0).max(30_000),
});

export const learningSettingsSchema = z.object({
  minPaperOpportunities: z.number().int().min(0),
  minSimulatedExecutions: z.number().int().min(0),
  minExecutionAccuracy: z.number().min(0).max(1),
  minSlippageAccuracy: z.number().min(0).max(1),
  minFeeAccuracy: z.number().min(0).max(1),
  minLatencySamples: z.number().int().min(0),
  maxPaperDrawdownEur: z.number().min(0),
  maxFailureRate: z.number().min(0).max(1),
  /** Chronological split: calibration / validation / out-of-sample. */
  splits: z.tuple([z.number().min(0.1), z.number().min(0.05), z.number().min(0.05)]),
  walkForwardFolds: z.number().int().min(2).max(20),
  optimizeIntervalMin: z.number().int().min(0).max(10_080),
  /** Live trades at the current level before the next level becomes eligible (user confirms). */
  levelUpMinTrades: z.number().int().min(1),
  /** Live expectancy below paper expectancy by more than this (bps) → pause live, back to paper. */
  liveDegradationBps: bpsSchema,
});

export const settingsSchema = z.object({
  capital: capitalSettingsSchema,
  risk: riskSettingsSchema,
  strategy: strategySettingsSchema,
  scanner: scannerSettingsSchema,
  paper: paperSettingsSchema,
  learning: learningSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  capital: {
    startingCapitalEur: 15,
    reserveCapitalEur: 10,
    maxTradeEur: 5,
    maxConcurrentTrades: 1,
    paperCapitalEur: 15,
  },
  risk: {
    maxLossPerTradeEur: 0.3,
    dailyLossLimitEur: 0.75,
    maxConsecutiveFailures: 3,
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxPriorityFeeLamports: 200_000,
    maxJitoTipLamports: 200_000,
    maxJitoTipShareOfProfit: 0.5,
    requireAtomic: true,
    nonAtomicExtraBufferBps: 50,
    tokenAllowlist: [],
    tokenDenylist: [],
    liveLevel: 1,
    liveLevelMaxTradeEur: [1, 2, 3, 5],
    emergencyStop: false,
  },
  strategy: {
    directEnabled: true,
    triangularEnabled: true,
    tradeSizesEur: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
    screenMinSpreadBps: 8,
    maxQuoteAgeMs: 1500,
    minNetProfitEur: 0.005,
    minNetProfitPercent: 0.1,
    minExecutionProbability: 0.5,
    safetyBufferBps: 10,
    legSlippageBps: 30,
    priorityFeePercentile: 50,
    jitoTipPercentile: 50,
    useJito: true,
  },
  scanner: {
    poolPollMs: 2000,
    minPoolTvlUsd: 50_000,
    maxPoolsPerTokenPerDex: 2,
    poolRefreshMin: 30,
    maxCandidatesPerMinute: 4,
    maxTriangularSwaps: 3,
  },
  paper: {
    defaultLatencyMs: 900,
  },
  learning: {
    minPaperOpportunities: 5000,
    minSimulatedExecutions: 500,
    minExecutionAccuracy: 0.8,
    minSlippageAccuracy: 0.8,
    minFeeAccuracy: 0.8,
    minLatencySamples: 200,
    maxPaperDrawdownEur: 1,
    maxFailureRate: 0.3,
    splits: [0.6, 0.2, 0.2],
    walkForwardFolds: 4,
    optimizeIntervalMin: 360,
    levelUpMinTrades: 25,
    liveDegradationBps: 15,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge a partial update into settings (arrays and tuples are replaced) and validate. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
    return out;
  };
  return settingsSchema.parse(merge(base, patch));
}

/** Load stored settings leniently: unknown keys dropped, missing keys filled from defaults. */
export function settingsFromStored(stored: unknown): Settings {
  const merged = mergeSettings(DEFAULT_SETTINGS, {});
  if (!isPlainObject(stored)) return merged;
  const pick = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) out[k] = pick(a[k], b[k]);
    return out;
  };
  const parsed = settingsSchema.safeParse(pick(merged, stored));
  return parsed.success ? parsed.data : merged;
}

/**
 * Keys the system may change on its own (strategy optimisation). Everything under capital/risk is
 * user-owned: automatic changes there may only make trading MORE conservative.
 */
export const SELF_TUNABLE_STRATEGY_KEYS = [
  "minNetProfitEur",
  "minNetProfitPercent",
  "screenMinSpreadBps",
  "maxQuoteAgeMs",
  "minExecutionProbability",
  "safetyBufferBps",
  "legSlippageBps",
  "priorityFeePercentile",
  "jitoTipPercentile",
  "tradeSizesEur",
] as const;
export type SelfTunableKey = (typeof SELF_TUNABLE_STRATEGY_KEYS)[number];

/**
 * Returns true when `next` is at least as conservative as `prev` for every user-owned risk value.
 * Used to guarantee that no automatic process ever raises a risk limit.
 */
export function isRiskNotIncreased(prev: Settings, next: Settings): boolean {
  const c = prev.capital;
  const n = next.capital;
  const r = prev.risk;
  const m = next.risk;
  return (
    n.maxTradeEur <= c.maxTradeEur &&
    n.maxConcurrentTrades <= c.maxConcurrentTrades &&
    n.reserveCapitalEur >= c.reserveCapitalEur &&
    m.maxLossPerTradeEur <= r.maxLossPerTradeEur &&
    m.dailyLossLimitEur <= r.dailyLossLimitEur &&
    m.maxConsecutiveFailures <= r.maxConsecutiveFailures &&
    m.maxSlippageBps <= r.maxSlippageBps &&
    m.maxPriceImpactBps <= r.maxPriceImpactBps &&
    m.maxPriorityFeeLamports <= r.maxPriorityFeeLamports &&
    m.maxJitoTipLamports <= r.maxJitoTipLamports &&
    m.maxJitoTipShareOfProfit <= r.maxJitoTipShareOfProfit &&
    (m.requireAtomic || !r.requireAtomic) &&
    m.liveLevel <= r.liveLevel &&
    m.liveLevelMaxTradeEur.every((v, i) => v <= (r.liveLevelMaxTradeEur[i] as number))
  );
}
