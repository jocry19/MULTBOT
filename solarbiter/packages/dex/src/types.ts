import type { DexId, PoolInfo, PoolKind, PoolState, Quote } from "@solarbiter/shared";

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  inputDecimals: number;
  outputDecimals: number;
  amount: bigint;
  slippageBps: number;
  /** Single-hop only (direct arbitrage legs). */
  onlyDirectRoutes: boolean;
  /** Keep the route small enough to fit two legs into one transaction. */
  maxAccounts?: number;
  /** Route will be sent inside a Jito bundle (excludes venues that are incompatible with bundles). */
  forJitoBundle?: boolean;
  /**
   * Request-budget priority. Final/requote checks protect money and are never starved by exploratory
   * size-ladder quotes.
   */
  priority: "final" | "requote" | "verify" | "ladder";
  /** Max time to wait for request budget; beyond that the quote is refused (QUOTE_BUDGET_EXHAUSTED). */
  maxWaitMs?: number;
}

/** A transaction instruction in wire form (as returned by routing APIs). */
export interface WireInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** base64 */
  data: string;
}

export interface SwapInstructions {
  computeBudget: WireInstruction[];
  setup: WireInstruction[];
  swap: WireInstruction;
  cleanup: WireInstruction | null;
  other: WireInstruction[];
  lookupTables: string[];
  /** Resolved lookup table contents when the provider returns them (saves RPC calls). */
  lookupTableAddresses: Record<string, string[]>;
  /** Minimum output encoded in the swap instruction. */
  minOutputAmount: bigint;
}

export interface BuildSwapRequest {
  quote: Quote;
  userPublicKey: string;
  /** Override the slippage tolerance (bps) that the swap instruction enforces. */
  slippageBps?: number;
  wrapAndUnwrapSol: boolean;
  maxWaitMs?: number;
}

export interface RouteValidation {
  ok: boolean;
  reasons: string[];
}

export interface LiquidityInfo {
  pool: string;
  tvlUsd: number;
  reserveA: number | null;
  reserveB: number | null;
  /** Trade size (in A units) that moves the marginal price by ~1 % (rough, for sizing caps). */
  depth1pctA: number | null;
}

/**
 * Adapter for one liquidity source. All DEX-specific logic lives behind this interface; the
 * scanner, profit engine and execution engine never look inside a DEX.
 */
export interface DexAdapter {
  readonly id: DexId;
  /** Venue labels used by the routing layer for this DEX (e.g. Jupiter "dexes" filter). */
  readonly labels: string[];
  readonly poolKinds: PoolKind[];
  /** Integration status. An unavailable adapter never produces quotes (fail safe). */
  available(): { ok: boolean; reason: string | null };

  /** Firm, executable quote restricted to this DEX. */
  getQuote(req: QuoteRequest): Promise<Quote>;
  /** Instructions for exactly this quote (with enforced minimum output). */
  buildSwap(req: BuildSwapRequest): Promise<SwapInstructions>;
  getLiquidity(pool: PoolInfo, state: PoolState | null): LiquidityInfo;
  getFees(pool: PoolInfo): { feeRate: number; source: string };
  /** The route must only touch this DEX's venues (and the expected mints). */
  validateRoute(quote: Quote, expect: { inputMint: string; outputMint: string; maxHops: number }): RouteValidation;

  /** Pool discovery through the DEX's public API (+ on-chain enrichment). */
  discoverPools(mintA: string, mintB: string, opts: { minTvlUsd: number; limit: number }): Promise<PoolInfo[]>;
  /** Accounts needed to decode the pool's state. */
  stateAccounts(pool: PoolInfo): string[];
  decodeState(pool: PoolInfo, accounts: Map<string, Buffer>, slot: number, now: number): PoolState | null;
}
