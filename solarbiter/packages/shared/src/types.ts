import type { DexId, OpportunityStatus, PoolKind, RejectionReason, StrategyType, TradeMode } from "./enums.js";

/** One hop of a route (a single pool swap). */
export interface RouteHop {
  dex: DexId;
  /** Venue label as reported by the quote source (e.g. "Raydium CLMM", "Whirlpool"). */
  label: string;
  pool: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
}

/**
 * A price quote.
 *   firm   = executable quote from a routing API for an exact amount (basis for every decision)
 *   screen = marginal price derived from decoded pool state (only used to find candidates)
 */
export interface Quote {
  id: string;
  kind: "firm" | "screen";
  /** When the quote response was received (ms). */
  timestamp: number;
  /** Slot the quote was computed at (null if the source does not report it). */
  slot: number | null;
  source: DexId;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  /** Minimum output the swap instruction will enforce (after slippage tolerance). */
  minOutputAmount: bigint;
  slippageBps: number;
  /** Output per input in UI units. */
  price: number;
  /** Fraction (0.001 = 0.1 %). */
  priceImpact: number;
  /** Pool fee rate(s) along the route as fractions (informational; outputs are already net of them). */
  feeRates: number[];
  route: RouteHop[];
  /** Round-trip time of the request. */
  latencyMs: number;
  /** Opaque source payload needed to build the swap (e.g. Jupiter quoteResponse). */
  raw?: unknown;
}

export function quoteAgeMs(q: Pick<Quote, "timestamp">, now: number): number {
  return Math.max(0, now - q.timestamp);
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  program: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  allowlisted: boolean;
  denylisted: boolean;
  safe: boolean;
  safetyReasons: string[];
}

export interface PoolInfo {
  address: string;
  dex: DexId;
  kind: PoolKind;
  programId: string;
  /** Venue label used by the routing API for this pool family. */
  label: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  vaultA: string | null;
  vaultB: string | null;
  /** Fee rate as a fraction (0.0025 = 0.25 %). */
  feeRate: number;
  tvlUsd: number;
  /** Extra accounts needed to decode the state (e.g. Raydium CPMM amm config). */
  extra: Record<string, string>;
}

/** Decoded pool state (marginal price) at a slot. */
export interface PoolState {
  pool: string;
  dex: DexId;
  kind: PoolKind;
  mintA: string;
  mintB: string;
  slot: number;
  fetchedAt: number;
  /** Marginal price: units of B per 1 A (UI units). */
  priceAInB: number;
  feeRate: number;
  /** Reserves in UI units where meaningful (constant-product pools, DLMM bin reserves). */
  reserveA: number | null;
  reserveB: number | null;
  /** Concentrated liquidity L (CLMM / Whirlpool). */
  liquidity: string | null;
  active: boolean;
}

/** Every cost component of one opportunity at one size, in lamports (SOL-denominated routes). */
export interface CostBreakdown {
  inputLamports: bigint;
  /** Quoted output back in SOL (already net of DEX fees and price impact). */
  quotedOutputLamports: bigint;
  /** Mid-price spread before any cost (bps of input). */
  midSpreadBps: number;
  /** out − in from firm quotes. */
  grossProfitLamports: bigint;
  grossProfitBps: number;
  /** Informational split of what the quotes already contain. */
  dexFeesLamports: bigint;
  priceImpactLamports: bigint;
  /** Expected adverse move between quote and execution (learned spread decay). */
  expectedSlippageLamports: bigint;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
  jitoTipLamports: bigint;
  /** Rent for missing token accounts: locked capital, refundable — not a cost, but must be available. */
  rentLockedLamports: bigint;
  executionProbability: number;
  /** (1 − p) × cost of a failed attempt. */
  expectedFailureCostLamports: bigint;
  safetyBufferLamports: bigint;
  /** gross − slippage − network − priority − tip (profit if it lands). */
  netIfSuccessLamports: bigint;
  /** p × netIfSuccess − (1 − p) × failureCost. */
  expectedValueLamports: bigint;
  /** expectedValue − safety buffer: the only edge that counts. */
  usableEdgeLamports: bigint;
  usableEdgeBps: number;
}

export interface SizeEvaluation {
  sizeEur: number;
  inputLamports: bigint;
  outputLamports: bigint;
  costs: CostBreakdown;
  netEur: number;
  /** Size was evaluated from an interpolated impact model instead of a direct firm quote. */
  interpolated: boolean;
}

export interface DecisionLogLine {
  label: string;
  bps: number | null;
  lamports: bigint | null;
}

export interface Opportunity {
  id: string;
  timestamp: number;
  slot: number | null;
  mode: TradeMode;
  strategyType: StrategyType;
  strategyVersionId: string | null;
  /** Route mints, e.g. [SOL, TOKEN, SOL] or [SOL, USDC, TOKEN, SOL]. */
  route: string[];
  routeDexes: DexId[];
  inputMint: string;
  outputMint: string;
  /** Traded token (the non-SOL leg of a direct arbitrage). */
  tokenMint: string;
  sourceDex: DexId;
  destinationDex: DexId;
  inputAmount: bigint;
  outputAmount: bigint;
  sizeEur: number;
  solEur: number;
  grossProfit: bigint;
  grossProfitPercent: number;
  dexFees: bigint;
  networkFee: bigint;
  priorityFee: bigint;
  jitoTip: bigint;
  priceImpact: number;
  expectedSlippage: bigint;
  executionProbability: number;
  expectedFailureCost: bigint;
  safetyBuffer: bigint;
  expectedNetProfit: bigint;
  expectedNetProfitPercent: number;
  expectedNetProfitEur: number;
  quoteAge: number;
  latencyEstimate: number;
  atomic: boolean;
  status: OpportunityStatus;
  rejectionReason: RejectionReason | null;
  rejectionDetail: string | null;
  legs: Quote[];
  sizeLadder: SizeEvaluation[];
  costs: CostBreakdown | null;
  decisionLog: DecisionLogLine[];
}

export interface RiskDecision {
  allowed: boolean;
  codes: RejectionReason[];
  reasons: string[];
  checks: Record<string, boolean>;
}

/** Features of one opportunity used by the learned execution/slippage models. */
export interface ExecutionFeatures {
  strategyType: StrategyType;
  hops: number;
  /** Venue sequence, e.g. "raydium>orca". */
  dexes: string;
  sizeEur: number;
  /** Screening spread after pool fees (bps). */
  screenSpreadBps: number;
  /** Firm-quote gross (bps of input). */
  grossBps: number;
  quoteAgeMs: number;
  latencyMs: number;
  poolStateAgeMs: number;
  /** Recent SOL/EUR volatility (abs % move over 5 min, in bps). */
  volatilityBps: number;
  hourUtc: number;
}
