import {
  validateRouteGeneric,
  type BuildSwapRequest,
  type DexAdapter,
  type LiquidityInfo,
  type QuoteRequest,
  type RouteValidation,
  type SwapInstructions,
} from "@solarbiter/dex";
import type { DexId, PoolInfo, PoolKind, PoolState, Quote } from "@solarbiter/shared";
import type { JupiterClient } from "./client.js";

/**
 * Base for DEX adapters whose executable quotes and swap instructions come from the Jupiter routing
 * API restricted to the DEX's own venues (`dexes` filter). The DEX-specific parts — pool discovery,
 * state decoding, fees, liquidity — are implemented by each DEX adapter.
 */
export abstract class JupiterRoutedAdapter implements DexAdapter {
  abstract readonly id: DexId;
  abstract readonly labels: string[];
  abstract readonly poolKinds: PoolKind[];

  constructor(protected readonly jupiter: JupiterClient) {}

  available(): { ok: boolean; reason: string | null } {
    return this.jupiter.available();
  }

  getQuote(req: QuoteRequest): Promise<Quote> {
    return this.jupiter.quote(req, this.labels, this.id);
  }

  buildSwap(req: BuildSwapRequest): Promise<SwapInstructions> {
    if (req.quote.source !== this.id) throw new Error(`quote from ${req.quote.source} cannot be built by ${this.id}`);
    const v = this.validateRoute(req.quote, { inputMint: req.quote.inputMint, outputMint: req.quote.outputMint, maxHops: req.quote.route.length });
    if (!v.ok) throw new Error(`route rejected: ${v.reasons.join("; ")}`);
    return this.jupiter.swapInstructions(req);
  }

  validateRoute(quote: Quote, expect: { inputMint: string; outputMint: string; maxHops: number }): RouteValidation {
    return validateRouteGeneric(quote, expect, this.labels);
  }

  getLiquidity(pool: PoolInfo, state: PoolState | null): LiquidityInfo {
    const reserveA = state?.reserveA ?? null;
    const reserveB = state?.reserveB ?? null;
    return {
      pool: pool.address,
      tvlUsd: pool.tvlUsd,
      reserveA,
      reserveB,
      // constant product: Δx/x ≈ 0.5 % moves the price ~1 %
      depth1pctA: reserveA !== null ? reserveA * 0.005 : null,
    };
  }

  getFees(pool: PoolInfo): { feeRate: number; source: string } {
    return { feeRate: pool.feeRate, source: `${this.id} pool account` };
  }

  abstract discoverPools(mintA: string, mintB: string, opts: { minTvlUsd: number; limit: number }): Promise<PoolInfo[]>;
  abstract stateAccounts(pool: PoolInfo): string[];
  abstract decodeState(pool: PoolInfo, accounts: Map<string, Buffer>, slot: number, now: number): PoolState | null;
}

/**
 * The aggregated Jupiter route (any venue). Used as the reference "best execution" leg and for
 * triangular routes; it has no pools of its own.
 */
export class JupiterAdapter implements DexAdapter {
  readonly id = "jupiter" as const;
  readonly labels: string[] = [];
  readonly poolKinds: PoolKind[] = [];

  constructor(private readonly jupiter: JupiterClient) {}

  available(): { ok: boolean; reason: string | null } {
    return this.jupiter.available();
  }

  getQuote(req: QuoteRequest): Promise<Quote> {
    return this.jupiter.quote(req, null, this.id);
  }

  buildSwap(req: BuildSwapRequest): Promise<SwapInstructions> {
    return this.jupiter.swapInstructions(req);
  }

  validateRoute(quote: Quote, expect: { inputMint: string; outputMint: string; maxHops: number }): RouteValidation {
    return validateRouteGeneric(quote, expect, null);
  }

  getLiquidity(pool: PoolInfo): LiquidityInfo {
    return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: null, reserveB: null, depth1pctA: null };
  }

  getFees(): { feeRate: number; source: string } {
    return { feeRate: 0, source: "route fees are contained in the quoted output" };
  }

  async discoverPools(): Promise<PoolInfo[]> {
    return [];
  }

  stateAccounts(): string[] {
    return [];
  }

  decodeState(): PoolState | null {
    return null;
  }
}
