/**
 * Columnar, append-only trade tape per token with time-window queries.
 * Keeps only a bounded history (e.g. 60 min); older trades are evicted.
 *
 * All window queries are causal: they only consider trades with ts <= `to`.
 */

export interface TapeTrade {
  ts: number;
  sol: number;
  tokens: number;
  price: number;
  isBuy: boolean;
  trader: string;
  slot: number;
}

export interface WindowStats {
  trades: number;
  buys: number;
  sells: number;
  buyVolSol: number;
  sellVolSol: number;
  volSol: number;
  netFlowSol: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  uniqueTraders: number;
  firstPrice: number;
  lastPrice: number;
  high: number;
  low: number;
  maxBuySol: number;
  maxSellSol: number;
  /** Std-dev of log returns between consecutive trades in the window. */
  volatility: number;
  /** Largest number of distinct buyers inside one slot (coordination proxy). */
  maxBuyersSameSlot: number;
}

const EMPTY: WindowStats = {
  trades: 0,
  buys: 0,
  sells: 0,
  buyVolSol: 0,
  sellVolSol: 0,
  volSol: 0,
  netFlowSol: 0,
  uniqueBuyers: 0,
  uniqueSellers: 0,
  uniqueTraders: 0,
  firstPrice: 0,
  lastPrice: 0,
  high: 0,
  low: 0,
  maxBuySol: 0,
  maxSellSol: 0,
  volatility: 0,
  maxBuyersSameSlot: 0,
};

export class TradeTape {
  private ts: number[] = [];
  private sol: number[] = [];
  private tokens: number[] = [];
  private price: number[] = [];
  private buy: boolean[] = [];
  private trader: string[] = [];
  private slot: number[] = [];
  private start = 0;

  constructor(private readonly retentionMs: number) {}

  get length(): number {
    return this.ts.length - this.start;
  }

  get lastTs(): number | null {
    return this.ts.length > this.start ? (this.ts[this.ts.length - 1] as number) : null;
  }

  push(t: TapeTrade): void {
    // Trades normally arrive in order; tolerate small reordering by insertion.
    let i = this.ts.length;
    while (i > this.start && (this.ts[i - 1] as number) > t.ts) i--;
    if (i === this.ts.length) {
      this.ts.push(t.ts);
      this.sol.push(t.sol);
      this.tokens.push(t.tokens);
      this.price.push(t.price);
      this.buy.push(t.isBuy);
      this.trader.push(t.trader);
      this.slot.push(t.slot);
    } else {
      this.ts.splice(i, 0, t.ts);
      this.sol.splice(i, 0, t.sol);
      this.tokens.splice(i, 0, t.tokens);
      this.price.splice(i, 0, t.price);
      this.buy.splice(i, 0, t.isBuy);
      this.trader.splice(i, 0, t.trader);
      this.slot.splice(i, 0, t.slot);
    }
  }

  evictBefore(cutoff: number): void {
    while (this.start < this.ts.length && (this.ts[this.start] as number) < cutoff) this.start++;
    if (this.start > 2048 && this.start > this.ts.length / 2) {
      this.ts = this.ts.slice(this.start);
      this.sol = this.sol.slice(this.start);
      this.tokens = this.tokens.slice(this.start);
      this.price = this.price.slice(this.start);
      this.buy = this.buy.slice(this.start);
      this.trader = this.trader.slice(this.start);
      this.slot = this.slot.slice(this.start);
      this.start = 0;
    }
  }

  evict(now: number): void {
    this.evictBefore(now - this.retentionMs);
  }

  /** First index with ts > t (upper bound). */
  private upper(t: number): number {
    let lo = this.start;
    let hi = this.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.ts[mid] as number) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index with ts >= t (lower bound). */
  private lower(t: number): number {
    let lo = this.start;
    let hi = this.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.ts[mid] as number) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Last traded price at or before t (null if no trade yet in the tape). */
  priceAt(t: number): number | null {
    const i = this.upper(t) - 1;
    return i >= this.start ? (this.price[i] as number) : null;
  }

  /** Trades in (from, to]. */
  window(from: number, to: number): WindowStats {
    const a = this.upper(from);
    const b = this.upper(to);
    if (b <= a) return { ...EMPTY, firstPrice: this.priceAt(to) ?? 0, lastPrice: this.priceAt(to) ?? 0, high: this.priceAt(to) ?? 0, low: this.priceAt(to) ?? 0 };
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    let buys = 0;
    let sells = 0;
    let buyVol = 0;
    let sellVol = 0;
    let high = -Infinity;
    let low = Infinity;
    let maxBuy = 0;
    let maxSell = 0;
    let sumR = 0;
    let sumR2 = 0;
    let nR = 0;
    let prevPrice = a > this.start ? (this.price[a - 1] as number) : null;
    let slotBuyers = new Set<string>();
    let curSlot = -1;
    let maxSameSlot = 0;
    for (let i = a; i < b; i++) {
      const s = this.sol[i] as number;
      const p = this.price[i] as number;
      const tr = this.trader[i] as string;
      if (this.buy[i]) {
        buys++;
        buyVol += s;
        buyers.add(tr);
        if (s > maxBuy) maxBuy = s;
        const sl = this.slot[i] as number;
        if (sl !== curSlot) {
          curSlot = sl;
          slotBuyers = new Set();
        }
        slotBuyers.add(tr);
        if (slotBuyers.size > maxSameSlot) maxSameSlot = slotBuyers.size;
      } else {
        sells++;
        sellVol += s;
        sellers.add(tr);
        if (s > maxSell) maxSell = s;
      }
      if (p > high) high = p;
      if (p < low) low = p;
      if (prevPrice !== null && prevPrice > 0 && p > 0) {
        const r = Math.log(p / prevPrice);
        sumR += r;
        sumR2 += r * r;
        nR++;
      }
      prevPrice = p;
    }
    const traders = new Set<string>([...buyers, ...sellers]);
    const mean = nR > 0 ? sumR / nR : 0;
    const variance = nR > 1 ? Math.max(0, sumR2 / nR - mean * mean) : 0;
    const firstPrice = a > this.start ? (this.price[a - 1] as number) : (this.price[a] as number);
    return {
      trades: b - a,
      buys,
      sells,
      buyVolSol: buyVol,
      sellVolSol: sellVol,
      volSol: buyVol + sellVol,
      netFlowSol: buyVol - sellVol,
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      uniqueTraders: traders.size,
      firstPrice,
      lastPrice: this.price[b - 1] as number,
      high,
      low,
      maxBuySol: maxBuy,
      maxSellSol: maxSell,
      volatility: Math.sqrt(variance),
      maxBuyersSameSlot: maxSameSlot,
    };
  }

  /** Distinct buyers in (from, to] that did NOT trade this token at or before `from` (within the tape). */
  newBuyers(from: number, to: number, seenBefore: (trader: string, before: number) => boolean): number {
    const a = this.upper(from);
    const b = this.upper(to);
    const set = new Set<string>();
    for (let i = a; i < b; i++) {
      if (!this.buy[i]) continue;
      const tr = this.trader[i] as string;
      if (!set.has(tr) && !seenBefore(tr, from)) set.add(tr);
    }
    return set.size;
  }

  /** Buyers (with SOL spent) in (from, to]. */
  buyersIn(from: number, to: number): Map<string, number> {
    const a = this.upper(from);
    const b = this.upper(to);
    const m = new Map<string, number>();
    for (let i = a; i < b; i++) {
      if (!this.buy[i]) continue;
      const tr = this.trader[i] as string;
      m.set(tr, (m.get(tr) ?? 0) + (this.sol[i] as number));
    }
    return m;
  }

  /** Sellers (with SOL received) in (from, to]. */
  sellersIn(from: number, to: number): Map<string, number> {
    const a = this.upper(from);
    const b = this.upper(to);
    const m = new Map<string, number>();
    for (let i = a; i < b; i++) {
      if (this.buy[i]) continue;
      const tr = this.trader[i] as string;
      m.set(tr, (m.get(tr) ?? 0) + (this.sol[i] as number));
    }
    return m;
  }

  /** Price path (ts, price) in [from, to]. */
  path(from: number, to: number): { ts: number; price: number }[] {
    const a = this.lower(from);
    const b = this.upper(to);
    const out: { ts: number; price: number }[] = [];
    for (let i = a; i < b; i++) out.push({ ts: this.ts[i] as number, price: this.price[i] as number });
    return out;
  }
}

/** Minute OHLCV bars (bounded ring, default 24h). */
export interface MinuteBar {
  t: number; // bucket start (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  buyVol: number;
  sellVol: number;
  buys: number;
  sells: number;
  buyers: Set<string>;
  sellers: Set<string>;
  liquidity: number;
}

export class MinuteBars {
  readonly bars: MinuteBar[] = [];

  constructor(private readonly maxBars = 1440) {}

  add(ts: number, price: number, sol: number, isBuy: boolean, trader: string, liquidity: number): MinuteBar {
    const t = Math.floor(ts / 60_000) * 60_000;
    let bar = this.bars[this.bars.length - 1];
    if (!bar || bar.t < t) {
      bar = { t, o: price, h: price, l: price, c: price, buyVol: 0, sellVol: 0, buys: 0, sells: 0, buyers: new Set(), sellers: new Set(), liquidity };
      this.bars.push(bar);
      if (this.bars.length > this.maxBars) this.bars.shift();
    } else if (bar.t > t) {
      // late trade for an older bucket: find it (rare)
      const older = this.bars.find((b) => b.t === t);
      if (!older) return bar;
      bar = older;
    }
    bar.h = Math.max(bar.h, price);
    bar.l = Math.min(bar.l, price);
    bar.c = price;
    bar.liquidity = liquidity;
    if (isBuy) {
      bar.buyVol += sol;
      bar.buys++;
      bar.buyers.add(trader);
    } else {
      bar.sellVol += sol;
      bar.sells++;
      bar.sellers.add(trader);
    }
    return bar;
  }

  /** Aggregate completed bars with start in [from, to). */
  sum(from: number, to: number): { vol: number; buyVol: number; sellVol: number; trades: number; high: number; low: number; open: number | null; close: number | null } {
    let vol = 0;
    let buyVol = 0;
    let sellVol = 0;
    let trades = 0;
    let high = -Infinity;
    let low = Infinity;
    let open: number | null = null;
    let close: number | null = null;
    for (const b of this.bars) {
      if (b.t < from || b.t >= to) continue;
      vol += b.buyVol + b.sellVol;
      buyVol += b.buyVol;
      sellVol += b.sellVol;
      trades += b.buys + b.sells;
      if (b.h > high) high = b.h;
      if (b.l < low) low = b.l;
      if (open === null) open = b.o;
      close = b.c;
    }
    return { vol, buyVol, sellVol, trades, high, low, open, close };
  }
}
