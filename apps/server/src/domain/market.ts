import type { Venue } from "@multbot/shared";

/**
 * Normalised market data produced by the ingest layer.
 * Times are milliseconds since epoch. `availableAt` is when this system could first know the datum.
 */

export type DataSource = "live" | "backfill";

export interface MarketTrade {
  signature: string;
  eventIndex: number;
  slot: number;
  ts: number;
  availableAt: number;
  mint: string;
  venue: Venue;
  pool: string | null;
  trader: string;
  isBuy: boolean;
  /** Lamports entering (buy) or leaving (sell) the curve/pool, excluding fees. */
  solAmount: bigint;
  tokenAmount: bigint;
  /** All fees combined (protocol + creator + buyback + LP …), lamports. */
  feeLamports: bigint;
  /** Effective fee rate observed on this trade (fee / solAmount). */
  feeBps: number | null;
  /** Marginal price after the trade, SOL per whole token. */
  priceSol: number;
  marketCapSol: number | null;
  virtualSolReserves: bigint | null;
  virtualTokenReserves: bigint | null;
  realSolReserves: bigint | null;
  realTokenReserves: bigint | null;
  tokenDecimals: number;
  tokenSupply: bigint | null;
  ixName: string | null;
  mayhemMode: boolean;
  source: DataSource;
}

export interface TokenCreated {
  signature: string;
  slot: number;
  ts: number;
  availableAt: number;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  user: string;
  bondingCurve: string;
  tokenProgram: string | null;
  quoteMint: string | null;
  isMayhemMode: boolean;
  isCashback: boolean;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  source: DataSource;
}

export interface CurveCompleted {
  signature: string;
  slot: number;
  ts: number;
  availableAt: number;
  mint: string;
  bondingCurve: string;
  user: string;
  source: DataSource;
}

export interface TokenMigrated {
  signature: string;
  slot: number;
  ts: number;
  availableAt: number;
  mint: string;
  pool: string;
  solAmount: bigint;
  tokenAmount: bigint;
  poolMigrationFee: bigint;
  source: DataSource;
}

export interface PoolCreated {
  signature: string;
  slot: number;
  ts: number;
  availableAt: number;
  pool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseAmount: bigint;
  quoteAmount: bigint;
  coinCreator: string | null;
  creator: string;
  isMayhemMode: boolean;
  source: DataSource;
}

export interface LiquidityChanged {
  signature: string;
  eventIndex: number;
  slot: number;
  ts: number;
  availableAt: number;
  pool: string;
  mint: string | null;
  kind: "deposit" | "withdraw";
  user: string;
  baseAmount: bigint;
  quoteAmount: bigint;
  lpSupplyAfter: bigint;
  poolBaseAfter: bigint;
  poolQuoteAfter: bigint;
  source: DataSource;
}

export type MarketEvent =
  | { kind: "trade"; data: MarketTrade }
  | { kind: "create"; data: TokenCreated }
  | { kind: "complete"; data: CurveCompleted }
  | { kind: "migrate"; data: TokenMigrated }
  | { kind: "pool"; data: PoolCreated }
  | { kind: "liquidity"; data: LiquidityChanged };
