import type { MarketEvent } from "../../domain/market.js";
import { TokenState } from "./tokenState.js";

const BUCKET_MS = 10_000;

export interface MarketBucket {
  t: number;
  trades: number;
  volSol: number;
  buyVolSol: number;
  sellVolSol: number;
  newTokens: number;
  migrations: number;
  completions: number;
}

export interface MarketWindow {
  trades: number;
  volSol: number;
  buyVolSol: number;
  sellVolSol: number;
  newTokens: number;
  migrations: number;
  completions: number;
}

/**
 * Whole-market in-memory state: all active tokens plus 10-second market-wide buckets (24h).
 * Driven by normalised market events — identical for live ingest and historical replay.
 */
export class MarketState {
  readonly tokens = new Map<string, TokenState>();
  private readonly buckets: MarketBucket[] = [];
  /** Mints that must not be evicted (open positions). */
  readonly pinned = new Set<string>();
  /** Latest event time applied (the replay/live "now" as far as data is concerned). */
  lastEventTs = 0;

  constructor(private readonly tapeRetentionMs = 60 * 60_000) {}

  getOrCreate(mint: string, ts: number): TokenState {
    let t = this.tokens.get(mint);
    if (!t) {
      t = new TokenState(mint, ts, this.tapeRetentionMs);
      this.tokens.set(mint, t);
    }
    return t;
  }

  private bucket(ts: number): MarketBucket {
    const t = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    let last = this.buckets[this.buckets.length - 1];
    if (last && last.t === t) return last;
    if (last && last.t > t) {
      // late event: find the bucket (bounded search from the end)
      for (let i = this.buckets.length - 1; i >= Math.max(0, this.buckets.length - 60); i--) {
        const b = this.buckets[i] as MarketBucket;
        if (b.t === t) return b;
        if (b.t < t) break;
      }
      return last; // too old: attribute to latest bucket rather than dropping
    }
    last = { t, trades: 0, volSol: 0, buyVolSol: 0, sellVolSol: 0, newTokens: 0, migrations: 0, completions: 0 };
    this.buckets.push(last);
    if (this.buckets.length > (24 * 3_600_000) / BUCKET_MS) this.buckets.shift();
    return last;
  }

  /** Apply one normalised event. Returns the affected token (if any). */
  apply(ev: MarketEvent): TokenState | null {
    switch (ev.kind) {
      case "create": {
        const t = this.getOrCreate(ev.data.mint, ev.data.ts);
        t.applyCreate(ev.data);
        this.bucket(ev.data.ts).newTokens++;
        this.touch(ev.data.ts);
        return t;
      }
      case "trade": {
        const d = ev.data;
        const t = this.getOrCreate(d.mint, d.ts);
        t.applyTrade(d);
        const b = this.bucket(d.ts);
        const sol = Number(d.solAmount) / 1e9;
        b.trades++;
        b.volSol += sol;
        if (d.isBuy) b.buyVolSol += sol;
        else b.sellVolSol += sol;
        this.touch(d.ts);
        return t;
      }
      case "complete": {
        const t = this.getOrCreate(ev.data.mint, ev.data.ts);
        t.applyComplete(ev.data.ts);
        this.bucket(ev.data.ts).completions++;
        this.touch(ev.data.ts);
        return t;
      }
      case "migrate": {
        const t = this.getOrCreate(ev.data.mint, ev.data.ts);
        t.applyMigration(ev.data.ts, ev.data.pool);
        this.bucket(ev.data.ts).migrations++;
        this.touch(ev.data.ts);
        return t;
      }
      case "liquidity": {
        if (!ev.data.mint) return null;
        const t = this.tokens.get(ev.data.mint);
        t?.applyLiquidity(ev.data);
        this.touch(ev.data.ts);
        return t ?? null;
      }
      case "pool":
        this.touch(ev.data.ts);
        return null;
    }
  }

  private touch(ts: number): void {
    if (ts > this.lastEventTs) this.lastEventTs = ts;
  }

  /** Market-wide aggregates over buckets starting in (now - windowMs, now]. */
  window(now: number, windowMs: number): MarketWindow {
    const from = now - windowMs;
    const out: MarketWindow = { trades: 0, volSol: 0, buyVolSol: 0, sellVolSol: 0, newTokens: 0, migrations: 0, completions: 0 };
    for (let i = this.buckets.length - 1; i >= 0; i--) {
      const b = this.buckets[i] as MarketBucket;
      if (b.t + BUCKET_MS <= from) break;
      if (b.t > now) continue;
      out.trades += b.trades;
      out.volSol += b.volSol;
      out.buyVolSol += b.buyVolSol;
      out.sellVolSol += b.sellVolSol;
      out.newTokens += b.newTokens;
      out.migrations += b.migrations;
      out.completions += b.completions;
    }
    return out;
  }

  /** Tokens with at least one trade in (now - windowMs, now]. */
  activeTokens(now: number, windowMs: number): TokenState[] {
    const from = now - windowMs;
    const out: TokenState[] = [];
    for (const t of this.tokens.values()) if (t.lastTradeAt > from && t.lastTradeAt <= now) out.push(t);
    return out;
  }

  /** Drop tokens without trades for `inactiveMs` (except pinned) and trim tapes. Returns evicted mints. */
  evict(now: number, inactiveMs = 2 * 3_600_000): string[] {
    const evicted: string[] = [];
    for (const [mint, t] of this.tokens) {
      const last = Math.max(t.lastTradeAt, t.createdAt ?? 0, t.firstSeenAt);
      if (now - last > inactiveMs && !this.pinned.has(mint)) {
        this.tokens.delete(mint);
        evicted.push(mint);
      } else {
        t.evict(now);
      }
    }
    return evicted;
  }
}
