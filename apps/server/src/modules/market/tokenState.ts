import type { Venue } from "@multbot/shared";
import type { LiquidityChanged, MarketTrade, TokenCreated } from "../../domain/market.js";
import {
  INITIAL_REAL_TOKEN_RESERVES,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  PUMP_TOKEN_DECIMALS,
  PUMP_TOKEN_TOTAL_SUPPLY,
} from "../pumpfun/constants.js";
import { bondingProgress, type CurveState, type PoolState } from "../pumpfun/curve.js";
import { MinuteBars, TradeTape } from "./tape.js";

const SOL = 1e9;

export interface HolderInfo {
  balance: number; // whole tokens
  firstAt: number;
  lastAt: number;
}

export interface LiquidityEvent {
  ts: number;
  kind: "deposit" | "withdraw";
  quoteSol: number;
  user: string;
}

/**
 * Everything the system knows about one token at the current (causal) time.
 * Mutated only through `applyTrade` / `applyCreate` / … so live and replay behave identically.
 */
export class TokenState {
  readonly mint: string;
  createdAt: number | null = null;
  firstSeenAt: number;
  /** Start of continuous observation (features with longer windows than this are omitted). */
  observedSince: number;
  creator: string | null = null;
  name: string | null = null;
  symbol: string | null = null;
  isMayhem = false;
  venue: Venue = "pump_curve";
  complete = false;
  completedAt: number | null = null;
  migratedAt: number | null = null;
  pool: string | null = null;
  decimals = PUMP_TOKEN_DECIMALS;
  supply: bigint = PUMP_TOKEN_TOTAL_SUPPLY;

  curve: CurveState | null = null;
  poolState: PoolState | null = null;

  lastPrice = 0;
  lastTradeAt = 0;
  firstTradeAt: number | null = null;
  athPrice = 0;
  athAt = 0;
  lastFeeBps: number | null = null;

  readonly tape: TradeTape;
  readonly bars = new MinuteBars(1440);
  /** Balances reconstructed from observed trades (exact if seen from creation, excluding transfers). */
  readonly holders = new Map<string, HolderInfo>();
  /** Whether we observed the token since creation (holder data complete). */
  seenFromCreation = false;
  /** First-seen time per trader in this token (for "new buyer" features). */
  readonly traderFirstSeen = new Map<string, number>();
  readonly firstBuyers: string[] = [];
  readonly liquidityEvents: LiquidityEvent[] = [];

  trades = 0;
  buys = 0;
  sells = 0;
  buyVolSol = 0;
  sellVolSol = 0;
  creatorBoughtTokens = 0;
  creatorSoldTokens = 0;
  creatorFirstSellAt: number | null = null;

  /** Last time features/strategies were evaluated for this token (throttling). */
  lastEvaluatedAt = 0;
  /** Trade count at last evaluation. */
  lastEvaluatedTrades = 0;

  constructor(mint: string, firstSeenAt: number, tapeRetentionMs = 60 * 60_000) {
    this.mint = mint;
    this.firstSeenAt = firstSeenAt;
    this.observedSince = firstSeenAt;
    this.tape = new TradeTape(tapeRetentionMs);
  }

  ageAt(now: number): number {
    return Math.max(0, (now - (this.createdAt ?? this.firstSeenAt)) / 1000);
  }

  /** Seconds of continuous observation (full age if seen since creation). */
  coverageAt(now: number): number {
    if (this.seenFromCreation) return this.ageAt(now);
    return Math.max(0, (now - this.observedSince) / 1000);
  }

  /** Real SOL backing the price (curve real reserves or pool quote reserves). */
  get liquiditySol(): number {
    if (this.venue === "pump_amm" && this.poolState) return Number(this.poolState.quoteReserves) / SOL;
    if (this.curve) return Number(this.curve.realSolReserves) / SOL;
    return 0;
  }

  get marketCapSol(): number {
    return this.lastPrice * (Number(this.supply) / 10 ** this.decimals);
  }

  get bondingProgress(): number {
    if (this.venue === "pump_amm" || this.complete) return 1;
    return this.curve ? bondingProgress(this.curve, INITIAL_REAL_TOKEN_RESERVES) : 0;
  }

  applyCreate(c: TokenCreated): void {
    this.createdAt = c.ts;
    this.creator = c.creator;
    this.name = c.name;
    this.symbol = c.symbol;
    this.isMayhem = c.isMayhemMode;
    this.supply = c.tokenTotalSupply;
    this.seenFromCreation = this.trades === 0;
    if (!this.curve) {
      this.curve = {
        virtualSolReserves: c.virtualSolReserves || INITIAL_VIRTUAL_SOL_RESERVES,
        virtualTokenReserves: c.virtualTokenReserves || INITIAL_VIRTUAL_TOKEN_RESERVES,
        realSolReserves: 0n,
        realTokenReserves: c.realTokenReserves || INITIAL_REAL_TOKEN_RESERVES,
        tokenTotalSupply: c.tokenTotalSupply,
        complete: false,
      };
      this.lastPrice =
        Number(this.curve.virtualSolReserves) / SOL / (Number(this.curve.virtualTokenReserves) / 10 ** this.decimals);
    }
  }

  applyTrade(t: MarketTrade): void {
    const tokens = Number(t.tokenAmount) / 10 ** t.tokenDecimals;
    const sol = Number(t.solAmount) / SOL;
    this.decimals = t.tokenDecimals;
    if (t.tokenSupply) this.supply = t.tokenSupply;
    if (t.venue === "pump_amm") {
      this.venue = "pump_amm";
      this.pool = t.pool;
      if (t.virtualSolReserves !== null && t.virtualTokenReserves !== null) {
        this.poolState = {
          baseReserves: t.virtualTokenReserves,
          quoteReserves: t.virtualSolReserves,
          baseDecimals: t.tokenDecimals,
          baseSupply: t.tokenSupply ?? this.supply,
        };
      }
    } else if (t.virtualSolReserves !== null && t.virtualTokenReserves !== null) {
      const real = t.realTokenReserves ?? 0n;
      this.curve = {
        virtualSolReserves: t.virtualSolReserves,
        virtualTokenReserves: t.virtualTokenReserves,
        realSolReserves: t.realSolReserves ?? 0n,
        realTokenReserves: real,
        tokenTotalSupply: this.supply,
        complete: real <= 0n,
      };
      if (real <= 0n) this.complete = true;
    }
    if (t.feeBps !== null) this.lastFeeBps = t.feeBps;
    if (t.mayhemMode) this.isMayhem = true;

    this.tape.push({ ts: t.ts, sol, tokens, price: t.priceSol, isBuy: t.isBuy, trader: t.trader, slot: t.slot });
    this.bars.add(t.ts, t.priceSol, sol, t.isBuy, t.trader, this.liquiditySol);

    if (t.ts >= this.lastTradeAt) {
      this.lastPrice = t.priceSol;
      this.lastTradeAt = t.ts;
    }
    if (this.firstTradeAt === null || t.ts < this.firstTradeAt) this.firstTradeAt = t.ts;
    if (t.priceSol > this.athPrice) {
      this.athPrice = t.priceSol;
      this.athAt = t.ts;
    }
    this.trades++;
    if (t.isBuy) {
      this.buys++;
      this.buyVolSol += sol;
      if (this.firstBuyers.length < 20 && !this.firstBuyers.includes(t.trader)) this.firstBuyers.push(t.trader);
    } else {
      this.sells++;
      this.sellVolSol += sol;
    }
    if (!this.traderFirstSeen.has(t.trader)) this.traderFirstSeen.set(t.trader, t.ts);

    // holder balances (curve/pool accounts are not holders; they are never the trader)
    const h = this.holders.get(t.trader) ?? { balance: 0, firstAt: t.ts, lastAt: t.ts };
    h.balance += t.isBuy ? tokens : -tokens;
    if (h.balance < 1e-9) h.balance = 0;
    h.lastAt = t.ts;
    if (h.balance === 0) this.holders.delete(t.trader);
    else this.holders.set(t.trader, h);

    if (this.creator && t.trader === this.creator) {
      if (t.isBuy) this.creatorBoughtTokens += tokens;
      else {
        this.creatorSoldTokens += tokens;
        if (this.creatorFirstSellAt === null) this.creatorFirstSellAt = t.ts;
      }
    }
  }

  applyComplete(ts: number): void {
    this.complete = true;
    this.completedAt = ts;
  }

  applyMigration(ts: number, pool: string): void {
    this.migratedAt = ts;
    this.pool = pool;
    this.venue = "pump_amm";
    this.complete = true;
  }

  applyLiquidity(l: LiquidityChanged): void {
    this.liquidityEvents.push({ ts: l.ts, kind: l.kind, quoteSol: Number(l.quoteAmount) / SOL, user: l.user });
    if (this.liquidityEvents.length > 500) this.liquidityEvents.shift();
    if (this.poolState) {
      this.poolState = { ...this.poolState, baseReserves: l.poolBaseAfter, quoteReserves: l.poolQuoteAfter };
    }
  }

  /** Number of holders with a non-dust balance (dust: < 1e-6 of supply). */
  holderCount(): number {
    const dust = (Number(this.supply) / 10 ** this.decimals) * 1e-6;
    let n = 0;
    for (const h of this.holders.values()) if (h.balance > dust) n++;
    return n;
  }

  /** Holders count as of time t (reconstructed from first-acquisition times; approximate for sells). */
  holderCountAt(t: number): number {
    let n = 0;
    for (const h of this.holders.values()) if (h.firstAt <= t) n++;
    return n;
  }

  evict(now: number): void {
    this.tape.evict(now);
    const cutoff = now - 24 * 3_600_000;
    while (this.liquidityEvents.length > 0 && (this.liquidityEvents[0] as LiquidityEvent).ts < cutoff) this.liquidityEvents.shift();
  }
}
