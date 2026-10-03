import type { Venue } from "@multbot/shared";
import type { MarketTrade } from "../../domain/market.js";
import { LAMPORTS_PER_SIGNATURE, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../pumpfun/constants.js";
import { quoteCurveBuy, quoteCurveSell, quotePoolBuy, quotePoolSell, type CurveState, type PoolState } from "../pumpfun/curve.js";

/**
 * Realistic execution simulation shared by outcome labelling, backtests and paper trading.
 *
 * Execution happens `executionDelayMs` after the decision, against the actual market state at that
 * time (bonding curve or PumpSwap pool), with exact AMM math, DEX fees, priority + network fees,
 * token-account rent, an adverse MEV/latency haircut, liquidity caps (partial fills) and failed
 * transactions. Net P&L is computed from cash flows; gross P&L = net + all costs.
 */

const SOL = 1e9;

export interface VenueState {
  venue: Venue;
  curve: CurveState | null;
  pool: PoolState | null;
  feeBps: number;
  priceSol: number;
  decimals: number;
  /** Timestamp of the trade that defines this state. */
  ts: number;
  tradable: boolean;
}

export interface MarketView {
  stateAt(mint: string, t: number): VenueState | null;
}

export interface ExecutionParams {
  executionDelayMs: number;
  failedTxRate: number;
  priorityFeeSol: number;
  /** Signatures per transaction (base fee 5000 lamports each). */
  signatures: number;
  mevImpactBps: number;
  /** Rent for the associated token account (0 if it already exists). */
  ataRentSol: number;
  /** Close the token account after a full sell → rent is refunded. */
  closeAccountOnExit: boolean;
}

export const DEFAULT_EXECUTION: ExecutionParams = {
  executionDelayMs: 1500,
  failedTxRate: 0.05,
  priorityFeeSol: 0.0001,
  signatures: 1,
  mevImpactBps: 50,
  ataRentSol: TOKEN_ACCOUNT_RENT_LAMPORTS / SOL,
  closeAccountOnExit: true,
};

export interface EntryFill {
  ok: true;
  mint: string;
  decisionTs: number;
  execTs: number;
  venue: Venue;
  budgetSol: number;
  /** SOL actually spent on the swap (≤ budget when capped). */
  swapSol: number;
  tokens: number;
  tokensRaw: bigint;
  spotPrice: number;
  /** Effective price paid per token, including DEX fee, impact and MEV. */
  effectivePrice: number;
  dexFeeSol: number;
  slippageSol: number;
  mevSol: number;
  priorityFeeSol: number;
  networkFeeSol: number;
  rentSol: number;
  capped: boolean;
}

export interface ExitFill {
  ok: true;
  decisionTs: number;
  execTs: number;
  venue: Venue;
  tokens: number;
  spotPrice: number;
  effectivePrice: number;
  /** SOL received after DEX fee and MEV. */
  receivedSol: number;
  dexFeeSol: number;
  slippageSol: number;
  mevSol: number;
  priorityFeeSol: number;
  networkFeeSol: number;
  rentRefundSol: number;
  /** Tokens that could not be sold (liquidity cap) — valued at zero. */
  unsoldTokens: number;
  capped: boolean;
  retries: number;
}

export interface FailedFill {
  ok: false;
  decisionTs: number;
  execTs: number;
  reason: "tx_failed" | "not_tradable" | "zero_liquidity" | "no_state";
  /** Fees burnt by the failed attempt(s). */
  costSol: number;
}

export interface TradeResult {
  grossPnlSol: number;
  netPnlSol: number;
  netReturn: number;
  costs: {
    entryFeesSol: number;
    exitFeesSol: number;
    entrySlippageSol: number;
    exitSlippageSol: number;
    priorityFeesSol: number;
    networkFeesSol: number;
    mevImpactSol: number;
    rentSol: number;
    rentRefundSol: number;
    totalSol: number;
  };
}

function txFeeSol(p: ExecutionParams): number {
  return (p.signatures * LAMPORTS_PER_SIGNATURE) / SOL;
}

export function simulateEntry(
  view: MarketView,
  mint: string,
  decisionTs: number,
  budgetSol: number,
  p: ExecutionParams,
  rnd?: () => number,
): EntryFill | FailedFill {
  const execTs = decisionTs + p.executionDelayMs;
  const s = view.stateAt(mint, execTs);
  if (!s) return { ok: false, decisionTs, execTs, reason: "no_state", costSol: 0 };
  if (!s.tradable) return { ok: false, decisionTs, execTs, reason: "not_tradable", costSol: 0 };
  if (rnd && rnd() < p.failedTxRate) {
    return { ok: false, decisionTs, execTs, reason: "tx_failed", costSol: p.priorityFeeSol + txFeeSol(p) };
  }
  const budget = BigInt(Math.floor(budgetSol * SOL));
  const q =
    s.venue === "pump_curve" && s.curve
      ? quoteCurveBuy(s.curve, budget, s.feeBps, s.decimals)
      : s.pool
        ? quotePoolBuy(s.pool, budget, s.feeBps)
        : null;
  if (!q || q.tokensOut <= 0n) return { ok: false, decisionTs, execTs, reason: "zero_liquidity", costSol: p.priorityFeeSol + txFeeSol(p) };
  const unit = 10 ** s.decimals;
  const tokensPre = Number(q.tokensOut) / unit;
  const mevFrac = p.mevImpactBps / 10_000;
  const tokens = tokensPre * (1 - mevFrac);
  const swapSol = Number(q.solSpent) / SOL;
  const dexFeeSol = Number(q.feeLamports) / SOL;
  const intoCurve = Number(q.solIntoCurve) / SOL;
  const slippageSol = Math.max(0, intoCurve - tokensPre * s.priceSol);
  const mevSol = tokensPre * mevFrac * (swapSol / tokensPre);
  return {
    ok: true,
    mint,
    decisionTs,
    execTs,
    venue: s.venue,
    budgetSol,
    swapSol,
    tokens,
    tokensRaw: BigInt(Math.floor(tokens * unit)),
    spotPrice: s.priceSol,
    effectivePrice: swapSol / tokens,
    dexFeeSol,
    slippageSol,
    mevSol,
    priorityFeeSol: p.priorityFeeSol,
    networkFeeSol: txFeeSol(p),
    rentSol: p.ataRentSol,
    capped: q.capped,
  };
}

export function simulateExit(
  view: MarketView,
  mint: string,
  tokens: number,
  decisionTs: number,
  p: ExecutionParams,
  rnd?: () => number,
  maxRetries = 3,
): ExitFill | FailedFill {
  let retries = 0;
  let execTs = decisionTs + p.executionDelayMs;
  let burnt = 0;
  // a failed exit is retried after another delay (paying fees again)
  while (rnd && rnd() < p.failedTxRate && retries < maxRetries) {
    retries++;
    burnt += p.priorityFeeSol + txFeeSol(p);
    execTs += p.executionDelayMs;
  }
  let s = view.stateAt(mint, execTs);
  // completed curve waiting for migration: wait (bounded) until the pool trades
  let waited = 0;
  while (s && !s.tradable && waited < 10) {
    execTs += 30_000;
    waited++;
    s = view.stateAt(mint, execTs);
  }
  if (!s || !s.tradable) return { ok: false, decisionTs, execTs, reason: s ? "not_tradable" : "no_state", costSol: burnt };
  const unit = 10 ** s.decimals;
  const raw = BigInt(Math.floor(tokens * unit));
  const q =
    s.venue === "pump_curve" && s.curve
      ? quoteCurveSell(s.curve, raw, s.feeBps, s.decimals)
      : s.pool
        ? quotePoolSell(s.pool, raw, s.feeBps)
        : null;
  if (!q) return { ok: false, decisionTs, execTs, reason: "zero_liquidity", costSol: burnt };
  const mevFrac = p.mevImpactBps / 10_000;
  const netBeforeMev = Number(q.solOutNet) / SOL;
  const receivedSol = netBeforeMev * (1 - mevFrac);
  const gross = Number(q.solOutGross) / SOL;
  // capped sells: the part the pool could not pay is unsold (valued at 0)
  const soldFrac = q.capped && gross > 0 ? Math.min(1, gross / Math.max(1e-18, tokens * s.priceSol)) : 1;
  const soldTokens = q.capped ? tokens * soldFrac : tokens;
  return {
    ok: true,
    decisionTs,
    execTs,
    venue: s.venue,
    tokens,
    spotPrice: s.priceSol,
    effectivePrice: tokens > 0 ? receivedSol / tokens : 0,
    receivedSol,
    dexFeeSol: Number(q.feeLamports) / SOL,
    slippageSol: Math.max(0, soldTokens * s.priceSol - gross),
    mevSol: netBeforeMev * mevFrac,
    priorityFeeSol: p.priorityFeeSol * (retries + 1),
    networkFeeSol: txFeeSol(p) * (retries + 1),
    rentRefundSol: p.closeAccountOnExit ? p.ataRentSol : 0,
    unsoldTokens: tokens - soldTokens,
    capped: q.capped,
    retries,
  };
}

/** Cash-flow based P&L of a completed round trip. gross = net + total costs. */
export function tradeResult(entry: EntryFill, exit: ExitFill): TradeResult {
  const spent = entry.swapSol + entry.priorityFeeSol + entry.networkFeeSol + entry.rentSol;
  const received = exit.receivedSol + exit.rentRefundSol - exit.priorityFeeSol - exit.networkFeeSol;
  const net = received - spent;
  const costs = {
    entryFeesSol: entry.dexFeeSol,
    exitFeesSol: exit.dexFeeSol,
    entrySlippageSol: entry.slippageSol,
    exitSlippageSol: exit.slippageSol,
    priorityFeesSol: entry.priorityFeeSol + exit.priorityFeeSol,
    networkFeesSol: entry.networkFeeSol + exit.networkFeeSol,
    mevImpactSol: entry.mevSol + exit.mevSol,
    rentSol: entry.rentSol,
    rentRefundSol: exit.rentRefundSol,
    totalSol: 0,
  };
  costs.totalSol =
    costs.entryFeesSol +
    costs.exitFeesSol +
    costs.entrySlippageSol +
    costs.exitSlippageSol +
    costs.priorityFeesSol +
    costs.networkFeesSol +
    costs.mevImpactSol +
    costs.rentSol -
    costs.rentRefundSol;
  return { grossPnlSol: net + costs.totalSol, netPnlSol: net, netReturn: net / spent, costs };
}

/** Pre-trade cost estimate for a round trip at the current state (Entry Engine / Trade Explainer). */
export function estimateRoundTripCosts(
  s: VenueState,
  budgetSol: number,
  p: ExecutionParams,
): { entryImpact: number; totalCostSol: number; breakEvenMove: number; tokens: number } | null {
  const view: MarketView = { stateAt: () => s };
  const e = simulateEntry(view, "", s.ts - p.executionDelayMs, budgetSol, p);
  if (!e.ok) return null;
  const x = simulateExit({ stateAt: () => applyBuyToState(s, e) }, "", e.tokens, s.ts, p);
  if (!x.ok) return null;
  const r = tradeResult(e, x);
  // break-even move: price change needed so that net = 0 (costs are roughly proportional)
  return {
    entryImpact: e.effectivePrice / e.spotPrice - 1,
    totalCostSol: -r.netPnlSol,
    breakEvenMove: -r.netPnlSol / Math.max(1e-12, e.tokens * e.spotPrice),
    tokens: e.tokens,
  };
}

function applyBuyToState(s: VenueState, e: EntryFill): VenueState {
  const intoCurve = BigInt(Math.floor((e.swapSol - e.dexFeeSol) * SOL));
  const tokens = e.tokensRaw;
  if (s.venue === "pump_curve" && s.curve) {
    const curve: CurveState = {
      ...s.curve,
      virtualSolReserves: s.curve.virtualSolReserves + intoCurve,
      virtualTokenReserves: s.curve.virtualTokenReserves - tokens,
      realSolReserves: s.curve.realSolReserves + intoCurve,
      realTokenReserves: s.curve.realTokenReserves - tokens,
    };
    return { ...s, curve };
  }
  if (s.pool) {
    return { ...s, pool: { ...s.pool, baseReserves: s.pool.baseReserves - tokens, quoteReserves: s.pool.quoteReserves + intoCurve } };
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Market views
// ---------------------------------------------------------------------------------------------

/** Minimal trade record needed to reconstruct venue state (from DB or memory). */
export interface StateTrade {
  ts: number;
  venue: Venue;
  priceSol: number;
  feeBps: number | null;
  virtualSolReserves: bigint | null;
  virtualTokenReserves: bigint | null;
  realSolReserves: bigint | null;
  realTokenReserves: bigint | null;
  decimals: number;
  supply: bigint;
}

export function toStateTrade(t: MarketTrade): StateTrade {
  return {
    ts: t.ts,
    venue: t.venue,
    priceSol: t.priceSol,
    feeBps: t.feeBps,
    virtualSolReserves: t.virtualSolReserves,
    virtualTokenReserves: t.virtualTokenReserves,
    realSolReserves: t.realSolReserves,
    realTokenReserves: t.realTokenReserves,
    decimals: t.tokenDecimals,
    supply: t.tokenSupply ?? 1_000_000_000_000_000n,
  };
}

export function stateFromTrade(t: StateTrade, fallbackFeeBps = 125): VenueState {
  const feeBps = t.feeBps ?? fallbackFeeBps;
  if (t.venue === "pump_curve") {
    const real = t.realTokenReserves ?? 0n;
    const curve: CurveState | null =
      t.virtualSolReserves !== null && t.virtualTokenReserves !== null
        ? {
            virtualSolReserves: t.virtualSolReserves,
            virtualTokenReserves: t.virtualTokenReserves,
            realSolReserves: t.realSolReserves ?? 0n,
            realTokenReserves: real,
            tokenTotalSupply: t.supply,
            complete: real <= 0n,
          }
        : null;
    return { venue: "pump_curve", curve, pool: null, feeBps, priceSol: t.priceSol, decimals: t.decimals, ts: t.ts, tradable: curve !== null && !curve.complete };
  }
  const pool: PoolState | null =
    t.virtualSolReserves !== null && t.virtualTokenReserves !== null
      ? { baseReserves: t.virtualTokenReserves, quoteReserves: t.virtualSolReserves, baseDecimals: t.decimals, baseSupply: t.supply }
      : null;
  return { venue: "pump_amm", curve: null, pool, feeBps, priceSol: t.priceSol, decimals: t.decimals, ts: t.ts, tradable: pool !== null && pool.baseReserves > 0n };
}

/** Market view over historical trades of one or more mints (each list sorted by ts). */
export class HistoricalMarketView implements MarketView {
  private readonly trades = new Map<string, StateTrade[]>();

  set(mint: string, trades: StateTrade[]): void {
    this.trades.set(mint, trades);
  }

  has(mint: string): boolean {
    return this.trades.has(mint);
  }

  tradesOf(mint: string): StateTrade[] {
    return this.trades.get(mint) ?? [];
  }

  /** Index of the last trade with ts ≤ t (−1 if none). */
  indexAt(mint: string, t: number): number {
    const arr = this.trades.get(mint);
    if (!arr || arr.length === 0) return -1;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((arr[mid] as StateTrade).ts <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  stateAt(mint: string, t: number): VenueState | null {
    const i = this.indexAt(mint, t);
    if (i < 0) return null;
    const arr = this.trades.get(mint) as StateTrade[];
    const trade = arr[i] as StateTrade;
    // fee: most recent observed fee rate on this venue
    let feeBps = trade.feeBps;
    for (let j = i; feeBps === null && j >= Math.max(0, i - 20); j--) feeBps = (arr[j] as StateTrade).feeBps;
    return stateFromTrade({ ...trade, feeBps });
  }
}
