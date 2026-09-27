import { PUMP_TOKEN_DECIMALS, SOL_DECIMALS } from "./constants.js";

/**
 * Exact integer math for the Pump bonding curve and PumpSwap constant-product pools.
 * Mirrors the program/SDK formulas so paper trading and backtests use the same execution math as
 * the chain (including fees and the real-token-reserve cap near completion).
 */

export interface CurveState {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export interface PoolState {
  /** Base (token) reserves in raw units. */
  baseReserves: bigint;
  /** Effective quote (SOL) reserves = vault balance + virtual quote reserves. */
  quoteReserves: bigint;
  baseDecimals: number;
  baseSupply: bigint;
}

const BPS = 10_000n;
const SOL_UNIT = 10 ** SOL_DECIMALS;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function tokenUnit(decimals = PUMP_TOKEN_DECIMALS): number {
  return 10 ** decimals;
}

/** Marginal price, SOL per whole token. */
export function curvePriceSol(state: Pick<CurveState, "virtualSolReserves" | "virtualTokenReserves">, decimals = PUMP_TOKEN_DECIMALS): number {
  if (state.virtualTokenReserves <= 0n) return 0;
  return Number(state.virtualSolReserves) / SOL_UNIT / (Number(state.virtualTokenReserves) / tokenUnit(decimals));
}

export function curveMarketCapSol(state: CurveState, decimals = PUMP_TOKEN_DECIMALS): number {
  return curvePriceSol(state, decimals) * (Number(state.tokenTotalSupply) / tokenUnit(decimals));
}

/** Fraction of the sellable curve supply already bought (0 … 1). */
export function bondingProgress(state: CurveState, initialRealTokenReserves: bigint): number {
  if (initialRealTokenReserves <= 0n) return 0;
  const sold = initialRealTokenReserves - state.realTokenReserves;
  return Math.max(0, Math.min(1, Number(sold) / Number(initialRealTokenReserves)));
}

export interface BuyQuote {
  tokensOut: bigint;
  /** SOL entering the curve (excluding fees). */
  solIntoCurve: bigint;
  feeLamports: bigint;
  /** Total SOL spent (curve + fees). */
  solSpent: bigint;
  /** True if the buy hit the real-token-reserve cap (partial fill). */
  capped: boolean;
  spotPriceBefore: number;
  avgPrice: number;
  priceAfter: number;
  /** avgPrice / spotPriceBefore − 1 */
  priceImpact: number;
}

/** Buy with a SOL budget that includes fees (like the SDK's buy-by-SOL quote). */
export function quoteCurveBuy(state: CurveState, solBudget: bigint, feeBps: number, decimals = PUMP_TOKEN_DECIMALS): BuyQuote {
  if (state.complete || solBudget <= 0n) {
    const p = curvePriceSol(state, decimals);
    return { tokensOut: 0n, solIntoCurve: 0n, feeLamports: 0n, solSpent: 0n, capped: state.complete, spotPriceBefore: p, avgPrice: p, priceAfter: p, priceImpact: 0 };
  }
  const fee = BigInt(Math.max(0, Math.round(feeBps)));
  let solIn = (solBudget * BPS) / (BPS + fee);
  let tokensOut = (state.virtualTokenReserves * solIn) / (state.virtualSolReserves + solIn);
  let capped = false;
  if (tokensOut >= state.realTokenReserves) {
    tokensOut = state.realTokenReserves;
    capped = true;
    // SOL required to take exactly the remaining real tokens
    solIn = ceilDiv(state.virtualSolReserves * tokensOut, state.virtualTokenReserves - tokensOut);
  }
  const feeLamports = ceilDiv(solIn * fee, BPS);
  const spotPriceBefore = curvePriceSol(state, decimals);
  const after = {
    virtualSolReserves: state.virtualSolReserves + solIn,
    virtualTokenReserves: state.virtualTokenReserves - tokensOut,
  };
  const avgPrice = tokensOut > 0n ? Number(solIn + feeLamports) / SOL_UNIT / (Number(tokensOut) / tokenUnit(decimals)) : spotPriceBefore;
  return {
    tokensOut,
    solIntoCurve: solIn,
    feeLamports,
    solSpent: solIn + feeLamports,
    capped,
    spotPriceBefore,
    avgPrice,
    priceAfter: curvePriceSol(after, decimals),
    priceImpact: spotPriceBefore > 0 ? avgPrice / spotPriceBefore - 1 : 0,
  };
}

export interface SellQuote {
  /** Gross SOL out of the curve before fees. */
  solOutGross: bigint;
  feeLamports: bigint;
  /** SOL received by the seller. */
  solOutNet: bigint;
  /** True if the curve could not pay the full amount (real SOL reserves). */
  capped: boolean;
  spotPriceBefore: number;
  avgPrice: number;
  priceAfter: number;
  priceImpact: number;
}

export function quoteCurveSell(state: CurveState, tokensIn: bigint, feeBps: number, decimals = PUMP_TOKEN_DECIMALS): SellQuote {
  const spotPriceBefore = curvePriceSol(state, decimals);
  if (tokensIn <= 0n) {
    return { solOutGross: 0n, feeLamports: 0n, solOutNet: 0n, capped: false, spotPriceBefore, avgPrice: spotPriceBefore, priceAfter: spotPriceBefore, priceImpact: 0 };
  }
  let solOut = (tokensIn * state.virtualSolReserves) / (state.virtualTokenReserves + tokensIn);
  let capped = false;
  if (solOut > state.realSolReserves) {
    solOut = state.realSolReserves;
    capped = true;
  }
  const fee = BigInt(Math.max(0, Math.round(feeBps)));
  const feeLamports = ceilDiv(solOut * fee, BPS);
  const solOutNet = solOut > feeLamports ? solOut - feeLamports : 0n;
  const after = {
    virtualSolReserves: state.virtualSolReserves - solOut,
    virtualTokenReserves: state.virtualTokenReserves + tokensIn,
  };
  const avgPrice = Number(solOutNet) / SOL_UNIT / (Number(tokensIn) / tokenUnit(decimals));
  return {
    solOutGross: solOut,
    feeLamports,
    solOutNet,
    capped,
    spotPriceBefore,
    avgPrice,
    priceAfter: curvePriceSol(after, decimals),
    priceImpact: spotPriceBefore > 0 ? avgPrice / spotPriceBefore - 1 : 0,
  };
}

/** State after a buy/sell of the given curve amounts. */
export function applyCurveTrade(state: CurveState, isBuy: boolean, solAmount: bigint, tokenAmount: bigint): CurveState {
  if (isBuy) {
    const realTokenReserves = state.realTokenReserves - tokenAmount;
    return {
      ...state,
      virtualSolReserves: state.virtualSolReserves + solAmount,
      virtualTokenReserves: state.virtualTokenReserves - tokenAmount,
      realSolReserves: state.realSolReserves + solAmount,
      realTokenReserves,
      complete: realTokenReserves <= 0n,
    };
  }
  return {
    ...state,
    virtualSolReserves: state.virtualSolReserves - solAmount,
    virtualTokenReserves: state.virtualTokenReserves + tokenAmount,
    realSolReserves: state.realSolReserves - solAmount,
    realTokenReserves: state.realTokenReserves + tokenAmount,
  };
}

// ---------------------------------------------------------------------------------------------
// PumpSwap constant product
// ---------------------------------------------------------------------------------------------

export function poolPriceSol(pool: PoolState): number {
  if (pool.baseReserves <= 0n) return 0;
  return Number(pool.quoteReserves) / SOL_UNIT / (Number(pool.baseReserves) / tokenUnit(pool.baseDecimals));
}

export function quotePoolBuy(pool: PoolState, quoteBudget: bigint, feeBps: number): BuyQuote {
  const fee = BigInt(Math.max(0, Math.round(feeBps)));
  const spotPriceBefore = poolPriceSol(pool);
  if (quoteBudget <= 0n || pool.baseReserves <= 0n) {
    return { tokensOut: 0n, solIntoCurve: 0n, feeLamports: 0n, solSpent: 0n, capped: false, spotPriceBefore, avgPrice: spotPriceBefore, priceAfter: spotPriceBefore, priceImpact: 0 };
  }
  const quoteIn = (quoteBudget * BPS) / (BPS + fee);
  const baseOut = (pool.baseReserves * quoteIn) / (pool.quoteReserves + quoteIn);
  const feeLamports = ceilDiv(quoteIn * fee, BPS);
  const unit = tokenUnit(pool.baseDecimals);
  const avgPrice = baseOut > 0n ? Number(quoteIn + feeLamports) / SOL_UNIT / (Number(baseOut) / unit) : spotPriceBefore;
  const after: PoolState = { ...pool, baseReserves: pool.baseReserves - baseOut, quoteReserves: pool.quoteReserves + quoteIn };
  return {
    tokensOut: baseOut,
    solIntoCurve: quoteIn,
    feeLamports,
    solSpent: quoteIn + feeLamports,
    capped: false,
    spotPriceBefore,
    avgPrice,
    priceAfter: poolPriceSol(after),
    priceImpact: spotPriceBefore > 0 ? avgPrice / spotPriceBefore - 1 : 0,
  };
}

export function quotePoolSell(pool: PoolState, baseIn: bigint, feeBps: number): SellQuote {
  const fee = BigInt(Math.max(0, Math.round(feeBps)));
  const spotPriceBefore = poolPriceSol(pool);
  if (baseIn <= 0n) {
    return { solOutGross: 0n, feeLamports: 0n, solOutNet: 0n, capped: false, spotPriceBefore, avgPrice: spotPriceBefore, priceAfter: spotPriceBefore, priceImpact: 0 };
  }
  const quoteOut = (pool.quoteReserves * baseIn) / (pool.baseReserves + baseIn);
  const feeLamports = ceilDiv(quoteOut * fee, BPS);
  const net = quoteOut > feeLamports ? quoteOut - feeLamports : 0n;
  const unit = tokenUnit(pool.baseDecimals);
  const after: PoolState = { ...pool, baseReserves: pool.baseReserves + baseIn, quoteReserves: pool.quoteReserves - quoteOut };
  const avgPrice = Number(net) / SOL_UNIT / (Number(baseIn) / unit);
  return {
    solOutGross: quoteOut,
    feeLamports,
    solOutNet: net,
    capped: false,
    spotPriceBefore,
    avgPrice,
    priceAfter: poolPriceSol(after),
    priceImpact: spotPriceBefore > 0 ? avgPrice / spotPriceBefore - 1 : 0,
  };
}
