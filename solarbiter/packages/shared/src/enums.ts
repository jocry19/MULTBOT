/** Liquidity sources. "jupiter" = Jupiter's aggregated routing across all venues. */
export const DEX_IDS = ["raydium", "orca", "meteora", "jupiter"] as const;
export type DexId = (typeof DEX_IDS)[number];

/** On-chain pool program families whose state SOLARBITER decodes for screening. */
export const POOL_KINDS = ["raydium_amm_v4", "raydium_cpmm", "raydium_clmm", "orca_whirlpool", "meteora_dlmm"] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

export const STRATEGY_TYPES = ["direct", "triangular"] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export type TradeMode = "paper" | "live";

/**
 * Bot state machine. Default after start is PAPER — never LIVE.
 *   OFFLINE        worker not running
 *   INITIALIZING   startup sequence in progress
 *   NOT_READY      a critical component failed during startup / health checks → no trading at all
 *   PAPER          live market data, virtual execution
 *   SHADOW         like PAPER, plus real transaction simulation with the bot wallet
 *   LIVE           real money (only after the live gate + explicit user confirmation)
 *   PAUSED         no new trades (manual or by a circuit breaker)
 *   EMERGENCY_STOP everything halted until the user releases it
 */
export const BOT_STATES = ["OFFLINE", "INITIALIZING", "NOT_READY", "PAPER", "SHADOW", "LIVE", "PAUSED", "EMERGENCY_STOP"] as const;
export type BotState = (typeof BOT_STATES)[number];

/** Live gate: LIVE_READY is a recommendation; only the user can move to LIVE_ENABLED. */
export const LIVE_GATE_STATES = ["LIVE_LOCKED", "LIVE_READY", "LIVE_ENABLED"] as const;
export type LiveGateState = (typeof LIVE_GATE_STATES)[number];

export const OPPORTUNITY_STATUSES = ["DETECTED", "QUOTED", "EXECUTABLE", "REJECTED", "SIMULATED", "SUBMITTED", "CONFIRMED", "FAILED", "EXPIRED"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** Why no trade happened — the basis of the "WHY NO TRADE?" analytics. */
export const REJECTION_REASONS = [
  "SPREAD_TOO_SMALL",
  "SLIPPAGE_TOO_HIGH",
  "PRICE_IMPACT_TOO_HIGH",
  "LIQUIDITY_TOO_LOW",
  "FEES_TOO_HIGH",
  "PRIORITY_FEE_TOO_HIGH",
  "JITO_TOO_EXPENSIVE",
  "QUOTE_TOO_OLD",
  "EXECUTION_PROBABILITY_TOO_LOW",
  "NET_PROFIT_BELOW_THRESHOLD",
  "RISK_LIMIT",
  "DAILY_LOSS_LIMIT",
  "CONCURRENCY_LIMIT",
  "WALLET_RESERVE",
  "TOKEN_REJECTED",
  "SIMULATION_FAILED",
  "ROUTE_UNAVAILABLE",
  "NOT_ATOMIC",
  "CIRCUIT_BREAKER",
  "BOT_NOT_TRADING",
  "QUOTE_BUDGET_EXHAUSTED",
  "OPPORTUNITY_VANISHED",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const EXECUTION_STATUSES = ["DETECTED", "SIMULATED", "SUBMITTED", "CONFIRMED", "FAILED", "REJECTED"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const CIRCUIT_BREAKERS = [
  "RPC_OUTAGE",
  "QUOTE_OUTAGE",
  "STALE_QUOTES",
  "UNEXPECTED_SLIPPAGE",
  "UNEXPECTED_PRICE_MOVE",
  "WALLET_MISMATCH",
  "BALANCE_MISMATCH",
  "TX_FAILURE_SPIKE",
  "LATENCY_SPIKE",
  "DEX_OUTAGE",
  "JITO_PROBLEM",
  "DATABASE_FAILURE",
  "REDIS_FAILURE",
  "SECURITY_FAILURE",
] as const;
export type CircuitBreakerId = (typeof CIRCUIT_BREAKERS)[number];

/** Breakers that only block live trading (paper keeps learning from market data). */
export const LIVE_ONLY_BREAKERS: CircuitBreakerId[] = ["WALLET_MISMATCH", "BALANCE_MISMATCH", "TX_FAILURE_SPIKE", "JITO_PROBLEM"];

export const NOTIFICATION_TYPES = [
  "OPPORTUNITY_DETECTED",
  "TRADE_EXECUTED",
  "TRADE_FAILED",
  "LARGE_LOSS",
  "RISK_LIMIT",
  "DAILY_LIMIT",
  "LEARNING_MILESTONE",
  "LIVE_UNLOCK",
  "WALLET_CHANGE",
  "RPC_OUTAGE",
  "JITO_ERROR",
  "QUOTE_PROVIDER_ERROR",
  "EMERGENCY_STOP",
  "SYSTEM",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type Severity = "info" | "success" | "warning" | "error" | "critical";

export type ComponentStatus = "CONNECTED" | "DEGRADED" | "DISCONNECTED" | "DISABLED" | "UNKNOWN";
export type EngineState = "STOPPED" | "STARTING" | "RUNNING" | "ERROR";

/** Live trading levels: maximum trade size per level (EUR). A level up always needs the user. */
export const LIVE_LEVELS = [1, 2, 3, 4] as const;
export type LiveLevel = (typeof LIVE_LEVELS)[number];
