/**
 * Domain enums shared between server and dashboard.
 * Keep these as string unions (not TS enums) so they serialize 1:1 into JSON and Postgres.
 */

export const STRATEGY_STATUSES = [
  "DISCOVERED",
  "TESTING",
  "PAPER_TRADING",
  "PAPER_VALIDATED",
  "LIVE_ENABLED",
  "DEGRADED",
  "PAUSED",
  "REJECTED",
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

/** Why a strategy was rejected. Stored alongside status REJECTED. */
export const REJECTION_REASONS = [
  "INSUFFICIENT_SAMPLES",
  "NEGATIVE_NET_EXPECTANCY",
  "NOT_SIGNIFICANT_AFTER_MULTIPLE_TESTING",
  "FAILED_OUT_OF_SAMPLE",
  "FAILED_WALK_FORWARD",
  "POSSIBLE_OVERFIT",
  "UNSTABLE_ACROSS_REGIMES",
  "EXECUTION_INFEASIBLE",
  "PAPER_FAILED",
  "MANUAL",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Paper and live are strictly separated everywhere (tables, P&L, UI). */
export type TradeMode = "paper" | "live";

export type Side = "buy" | "sell";

/** Where a market trade happened. */
export type Venue = "pump_curve" | "pump_amm";

export type TradeStatus = "OPEN" | "CLOSING" | "CLOSED" | "FAILED";

export type OrderStatus =
  | "CREATED"
  | "QUOTED"
  | "VALIDATED"
  | "SIMULATED"
  | "SIGNED"
  | "SENT"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED"
  | "REJECTED";

export type LiveTradingState = "LOCKED" | "ACTIVE";

export type EngineState = "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "ERROR";

export type ComponentStatus = "CONNECTED" | "DEGRADED" | "DISCONNECTED" | "DISABLED" | "UNKNOWN";

export const REGIME_DIMENSIONS = ["activity", "volatility", "liquidity", "breadth", "flow"] as const;
export type RegimeDimension = (typeof REGIME_DIMENSIONS)[number];

/** Coarse regime label; the full regime state is a vector of dimension levels. */
export type RegimeLevel = "low" | "normal" | "high" | "extreme";

export type ExitReason =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "SIGNAL_INVALIDATED"
  | "MOMENTUM_REVERSAL"
  | "LIQUIDITY_DETERIORATION"
  | "SELL_PRESSURE"
  | "STRATEGY_DEGRADED"
  | "EXPECTED_VALUE_NEGATIVE"
  | "EMERGENCY_STOP"
  | "MANUAL"
  | "RECONCILIATION";

export type ActivityLevel = "debug" | "info" | "success" | "warning" | "error";

export type ReconciliationState = "OK" | "REQUIRED" | "RUNNING";
