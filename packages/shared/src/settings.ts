import { z } from "zod";

/**
 * User-configurable settings. Everything here is visible and editable in the dashboard
 * (Settings → Trading / Risk / Research). The server validates every update with these schemas.
 *
 * SOL amounts are expressed in SOL (not lamports) because that is what users read and type.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (UTC)");

export const tradingSettingsSchema = z.object({
  /** Nominal SOL per live position (before fees). */
  positionSizeSol: z.number().positive().max(100),
  /** Hard cap on simultaneously open live positions. */
  maxOpenPositions: z.number().int().min(1).max(100),
  paperTradingEnabled: z.boolean(),
  /** Virtual capital for the paper account. Never mixed with the real wallet. */
  paperCapitalSol: z.number().positive().max(1_000_000),
  paperPositionSizeSol: z.number().positive().max(1000),
  /** Paper positions per strategy (each strategy gets its own virtual slot budget to gather evidence). */
  paperMaxOpenPositionsPerStrategy: z.number().int().min(1).max(100),
  maxSlippageBps: z.number().int().min(1).max(5000),
  priorityFeeMode: z.enum(["auto", "manual"]),
  /** Used when priorityFeeMode = manual. Micro-lamports per compute unit. */
  manualPriorityFeeMicroLamports: z.number().int().min(0).max(100_000_000),
  /** Upper bound for the total priority fee of a single transaction. */
  maxPriorityFeeSol: z.number().min(0).max(0.1),
  strategySelection: z.enum(["auto", "manual"]),
  executionProvider: z.enum(["jupiter", "pumpportal"]),
});
export type TradingSettings = z.infer<typeof tradingSettingsSchema>;

export const riskSettingsSchema = z.object({
  maxDailyLossSol: z.number().min(0).max(1000),
  maxPortfolioExposureSol: z.number().min(0).max(10_000),
  maxTokenExposureSol: z.number().min(0).max(1000),
  /** SOL that must always stay in the wallet (fees, rent, emergency exits). */
  minWalletReserveSol: z.number().min(0).max(1000),
  emergencyStop: z.boolean(),
  /** What happens to open positions when the emergency stop is activated. */
  emergencyStopClosePositions: z.boolean(),
  pauseEntries: z.boolean(),
  pauseExits: z.boolean(),
  tradingHours: z.object({
    enabled: z.boolean(),
    startUtc: hhmm,
    endUtc: hhmm,
    /** 0 = Sunday … 6 = Saturday */
    days: z.array(z.number().int().min(0).max(6)),
  }),
  /** Empty list = every strategy the user enabled for live trading is allowed. */
  allowedStrategyIds: z.array(z.string()),
  allowedStrategyVersionIds: z.array(z.string()),
  /** Stop opening positions when data is older than this (stale data guard). */
  maxDataStalenessSec: z.number().int().min(1).max(600),
});
export type RiskSettings = z.infer<typeof riskSettingsSchema>;

export const researchSettingsSchema = z.object({
  /** Assumed delay between decision and on-chain execution for backtests/paper. */
  executionDelayMs: z.number().int().min(0).max(60_000),
  /** Probability that a transaction fails (fee still paid) used in backtests/paper. */
  failedTxRate: z.number().min(0).max(0.9),
  /** Priority fee assumed in backtests when no live estimate is available. */
  assumedPriorityFeeSol: z.number().min(0).max(0.1),
  /** Extra adverse price impact assumed for MEV/latency, in bps of notional. */
  mevImpactBps: z.number().int().min(0).max(5000),
  minSampleSize: z.number().int().min(10).max(1_000_000),
  /** False discovery rate for Benjamini–Hochberg across all tested hypotheses. */
  fdrAlpha: z.number().min(0.0001).max(0.5),
  walkForwardFolds: z.number().int().min(2).max(20),
  maxConditionsPerRecipe: z.number().int().min(1).max(6),
  maxHypothesesPerRun: z.number().int().min(100).max(1_000_000),
  /** How often the discovery pipeline runs automatically (minutes). 0 = manual only. */
  discoveryIntervalMin: z.number().int().min(0).max(10_080),
  /** Criteria for PAPER_VALIDATED (a recommendation only — never auto-enables live trading). */
  paperValidation: z.object({
    minTrades: z.number().int().min(10).max(100_000),
    minProfitFactor: z.number().min(1).max(10),
    /** One-sided confidence that mean net P&L > 0. */
    minConfidence: z.number().min(0.5).max(0.9999),
    maxDrawdownSol: z.number().min(0).max(1000),
  }),
  /** Decay monitoring window (closed trades). */
  decayWindowTrades: z.number().int().min(10).max(10_000),
  /** Data retention in days (older day partitions are dropped). */
  retention: z.object({
    rawTradesDays: z.number().int().min(1).max(3650),
    researchSamplesDays: z.number().int().min(1).max(3650),
    snapshotsDays: z.number().int().min(1).max(3650),
    eventsDays: z.number().int().min(1).max(3650),
  }),
});
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;

export const settingsSchema = z.object({
  trading: tradingSettingsSchema,
  risk: riskSettingsSchema,
  research: researchSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  trading: {
    positionSizeSol: 0.01,
    maxOpenPositions: 10,
    paperTradingEnabled: true,
    paperCapitalSol: 0.5,
    paperPositionSizeSol: 0.01,
    paperMaxOpenPositionsPerStrategy: 10,
    maxSlippageBps: 1500,
    priorityFeeMode: "auto",
    manualPriorityFeeMicroLamports: 200_000,
    maxPriorityFeeSol: 0.0005,
    strategySelection: "auto",
    executionProvider: "jupiter",
  },
  risk: {
    maxDailyLossSol: 0.05,
    maxPortfolioExposureSol: 0.12,
    maxTokenExposureSol: 0.02,
    minWalletReserveSol: 0.03,
    emergencyStop: false,
    emergencyStopClosePositions: false,
    pauseEntries: false,
    pauseExits: false,
    tradingHours: { enabled: false, startUtc: "00:00", endUtc: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
    allowedStrategyIds: [],
    allowedStrategyVersionIds: [],
    maxDataStalenessSec: 20,
  },
  research: {
    executionDelayMs: 1500,
    failedTxRate: 0.05,
    assumedPriorityFeeSol: 0.0001,
    mevImpactBps: 50,
    minSampleSize: 200,
    fdrAlpha: 0.05,
    walkForwardFolds: 4,
    maxConditionsPerRecipe: 3,
    maxHypothesesPerRun: 20_000,
    discoveryIntervalMin: 360,
    paperValidation: {
      minTrades: 100,
      minProfitFactor: 1.2,
      minConfidence: 0.95,
      maxDrawdownSol: 0.05,
    },
    decayWindowTrades: 50,
    retention: { rawTradesDays: 14, researchSamplesDays: 30, snapshotsDays: 7, eventsDays: 30 },
  },
};

/** Deep-merge a partial update into settings and validate the result. Throws ZodError if invalid. */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  return settingsSchema.parse(deepMerge(current, patch));
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== "object" || base === null) {
    return patch as T;
  }
  if (typeof patch !== "object" || patch === null) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}
