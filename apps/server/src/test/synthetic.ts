import type { MarketEvent, MarketTrade, TokenCreated } from "../domain/market.js";
import {
  INITIAL_REAL_TOKEN_RESERVES,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  PUMP_TOKEN_TOTAL_SUPPLY,
} from "../modules/pumpfun/constants.js";
import { applyCurveTrade, curvePriceSol, quoteCurveBuy, quoteCurveSell, type CurveState } from "../modules/pumpfun/curve.js";

/**
 * Deterministic synthetic market generator for tests: produces pump.fun-like token creations and
 * bonding-curve trades that obey the exact curve math.
 */

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

let sigCounter = 0;

export function freshCurve(): CurveState {
  return {
    virtualSolReserves: INITIAL_VIRTUAL_SOL_RESERVES,
    virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    realSolReserves: 0n,
    realTokenReserves: INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: PUMP_TOKEN_TOTAL_SUPPLY,
    complete: false,
  };
}

export class SyntheticToken {
  curve = freshCurve();
  readonly holdings = new Map<string, bigint>();
  slot = 1000;

  constructor(
    readonly mint: string,
    readonly creator: string,
    readonly createdAt: number,
    readonly feeBps = 125,
  ) {}

  createEvent(): MarketEvent {
    const data: TokenCreated = {
      signature: `sig-create-${this.mint}`,
      slot: this.slot,
      ts: this.createdAt,
      availableAt: this.createdAt + 500,
      mint: this.mint,
      name: `Token ${this.mint.slice(0, 4)}`,
      symbol: this.mint.slice(0, 4).toUpperCase(),
      uri: "",
      creator: this.creator,
      user: this.creator,
      bondingCurve: `curve-${this.mint}`,
      tokenProgram: null,
      quoteMint: null,
      isMayhemMode: false,
      isCashback: false,
      virtualSolReserves: this.curve.virtualSolReserves,
      virtualTokenReserves: this.curve.virtualTokenReserves,
      realTokenReserves: this.curve.realTokenReserves,
      tokenTotalSupply: PUMP_TOKEN_TOTAL_SUPPLY,
      source: "live",
    };
    return { kind: "create", data };
  }

  buy(trader: string, lamports: bigint, ts: number): MarketEvent | null {
    const q = quoteCurveBuy(this.curve, lamports, this.feeBps);
    if (q.tokensOut <= 0n) return null;
    this.curve = applyCurveTrade(this.curve, true, q.solIntoCurve, q.tokensOut);
    this.holdings.set(trader, (this.holdings.get(trader) ?? 0n) + q.tokensOut);
    return this.trade(trader, true, q.solIntoCurve, q.tokensOut, q.feeLamports, ts);
  }

  sell(trader: string, tokens: bigint, ts: number): MarketEvent | null {
    const held = this.holdings.get(trader) ?? 0n;
    const amount = tokens > held ? held : tokens;
    if (amount <= 0n) return null;
    const q = quoteCurveSell(this.curve, amount, this.feeBps);
    this.curve = applyCurveTrade(this.curve, false, q.solOutGross, amount);
    this.holdings.set(trader, held - amount);
    return this.trade(trader, false, q.solOutGross, amount, q.feeLamports, ts);
  }

  private trade(trader: string, isBuy: boolean, sol: bigint, tokens: bigint, fee: bigint, ts: number): MarketEvent {
    this.slot += 1;
    const price = curvePriceSol(this.curve);
    const data: MarketTrade = {
      signature: `sig-${++sigCounter}`,
      eventIndex: 0,
      slot: this.slot,
      ts,
      availableAt: ts + 400,
      mint: this.mint,
      venue: "pump_curve",
      pool: null,
      trader,
      isBuy,
      solAmount: sol,
      tokenAmount: tokens,
      feeLamports: fee,
      feeBps: this.feeBps,
      priceSol: price,
      marketCapSol: price * 1e9,
      virtualSolReserves: this.curve.virtualSolReserves,
      virtualTokenReserves: this.curve.virtualTokenReserves,
      realSolReserves: this.curve.realSolReserves,
      realTokenReserves: this.curve.realTokenReserves,
      tokenDecimals: 6,
      tokenSupply: PUMP_TOKEN_TOTAL_SUPPLY,
      ixName: isBuy ? "buy" : "sell",
      mayhemMode: false,
      source: "live",
    };
    return { kind: "trade", data };
  }
}

/**
 * Random-walk order flow for one token: `n` trades, ~`intervalMs` apart, buy probability `pBuy`.
 */
export function randomFlow(
  token: SyntheticToken,
  opts: { start: number; n: number; intervalMs: number; pBuy: number; traders: number; seed: number; maxBuyLamports?: bigint },
): MarketEvent[] {
  const r = rng(opts.seed);
  const out: MarketEvent[] = [];
  let ts = opts.start;
  const maxBuy = Number(opts.maxBuyLamports ?? 500_000_000n);
  for (let i = 0; i < opts.n; i++) {
    ts += Math.max(1, Math.round(opts.intervalMs * (0.5 + r())));
    const trader = `trader-${Math.floor(r() * opts.traders)}`;
    let ev: MarketEvent | null;
    if (r() < opts.pBuy) {
      ev = token.buy(trader, BigInt(Math.max(1_000_000, Math.floor(r() * maxBuy))), ts);
    } else {
      const held = token.holdings.get(trader) ?? 0n;
      ev = held > 0n ? token.sell(trader, held / 2n + 1n, ts) : token.buy(trader, 5_000_000n, ts);
    }
    if (ev) out.push(ev);
  }
  return out;
}
