import type { MarketTrade, TokenCreated } from "../../domain/market.js";
import type { CreatorIntel, CreatorProfile, WalletIntel, WalletProfile } from "../features/types.js";

/**
 * Incremental wallet & creator statistics built from the market trade stream.
 *
 * A wallet position (wallet × token) is "closed" when ≥ 99% of the bought tokens were sold; its
 * realised return then updates the wallet's statistics. Skill is the one-sided 95% lower confidence
 * bound of the mean position return — a wallet only counts as "smart" with statistical evidence.
 *
 * Totals are kept as base (persisted) + delta (not yet flushed) so DB writes are additive and a
 * wallet evicted from memory never loses history.
 */

export interface WalletTotals {
  firstSeenAt: number;
  lastSeenAt: number;
  trades: number;
  buys: number;
  sells: number;
  tokensTraded: number;
  volumeSol: number;
  realizedPnlSol: number;
  closedPositions: number;
  winningPositions: number;
  sumReturn: number;
  sumReturnSq: number;
  sumHoldSec: number;
  sumEntrySol: number;
  earlyEntries: number;
  tokensCreated: number;
}

export function emptyTotals(ts: number): WalletTotals {
  return {
    firstSeenAt: ts,
    lastSeenAt: ts,
    trades: 0,
    buys: 0,
    sells: 0,
    tokensTraded: 0,
    volumeSol: 0,
    realizedPnlSol: 0,
    closedPositions: 0,
    winningPositions: 0,
    sumReturn: 0,
    sumReturnSq: 0,
    sumHoldSec: 0,
    sumEntrySol: 0,
    earlyEntries: 0,
    tokensCreated: 0,
  };
}

interface WalletRecord {
  base: WalletTotals;
  delta: WalletTotals;
  clusterId: number | null;
  hydrated: boolean;
}

export interface OpenPosition {
  address: string;
  mint: string;
  tokensBought: number;
  tokensSold: number;
  costSol: number;
  proceedsSol: number;
  buys: number;
  sells: number;
  firstBuyAt: number | null;
  firstBuyAgeSec: number | null;
  lastTradeAt: number;
  dirty: boolean;
}

export interface ClosedPosition extends OpenPosition {
  closedAt: number;
  realizedPnlSol: number;
  returnPct: number;
}

interface CreatorRecord {
  tokensCreated: number;
  tokensCompleted: number;
  quickDumps: number;
  firstCreatedAt: number;
  lastCreatedAt: number;
  mints: Map<string, { createdAt: number; dumped: boolean; completed: boolean }>;
  dirty: boolean;
}

const MIN_CLOSED_FOR_SKILL = 10;
const Z95 = 1.645;

function add(a: WalletTotals, b: WalletTotals): WalletTotals {
  return {
    firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
    lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
    trades: a.trades + b.trades,
    buys: a.buys + b.buys,
    sells: a.sells + b.sells,
    tokensTraded: a.tokensTraded + b.tokensTraded,
    volumeSol: a.volumeSol + b.volumeSol,
    realizedPnlSol: a.realizedPnlSol + b.realizedPnlSol,
    closedPositions: a.closedPositions + b.closedPositions,
    winningPositions: a.winningPositions + b.winningPositions,
    sumReturn: a.sumReturn + b.sumReturn,
    sumReturnSq: a.sumReturnSq + b.sumReturnSq,
    sumHoldSec: a.sumHoldSec + b.sumHoldSec,
    sumEntrySol: a.sumEntrySol + b.sumEntrySol,
    earlyEntries: a.earlyEntries + b.earlyEntries,
    tokensCreated: a.tokensCreated + b.tokensCreated,
  };
}

export function profileFromTotals(t: WalletTotals, clusterId: number | null): WalletProfile {
  const n = t.closedPositions;
  const mean = n > 0 ? t.sumReturn / n : 0;
  const variance = n > 1 ? Math.max(0, (t.sumReturnSq - n * mean * mean) / (n - 1)) : 0;
  const lcb = n >= MIN_CLOSED_FOR_SKILL ? mean - (Z95 * Math.sqrt(variance)) / Math.sqrt(n) : 0;
  return {
    firstSeenAt: t.firstSeenAt,
    trades: t.trades,
    closedPositions: n,
    winRate: n > 0 ? t.winningPositions / n : 0,
    meanReturn: mean,
    realizedPnlSol: t.realizedPnlSol,
    skill: Math.max(0, lcb),
    earlyEntryRate: t.buys > 0 ? t.earlyEntries / t.buys : 0,
    clusterId,
    tokensCreated: t.tokensCreated,
  };
}

export class WalletBook implements WalletIntel, CreatorIntel {
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly positions = new Map<string, OpenPosition>();
  private readonly creators = new Map<string, CreatorRecord>();
  private readonly closedQueue: ClosedPosition[] = [];
  /** Wallets seen but not yet hydrated from the DB. */
  private readonly hydrateQueue = new Set<string>();

  get walletCount(): number {
    return this.wallets.size;
  }

  get openPositionCount(): number {
    return this.positions.size;
  }

  private record(address: string, ts: number): WalletRecord {
    let r = this.wallets.get(address);
    if (!r) {
      r = { base: emptyTotals(ts), delta: emptyTotals(ts), clusterId: null, hydrated: false };
      this.wallets.set(address, r);
      this.hydrateQueue.add(address);
    }
    return r;
  }

  /** Set persisted totals for a wallet (startup load / async hydration). */
  hydrate(address: string, base: WalletTotals, clusterId: number | null): void {
    const r = this.wallets.get(address);
    if (!r) {
      this.wallets.set(address, { base, delta: emptyTotals(base.lastSeenAt), clusterId, hydrated: true });
      return;
    }
    r.base = base;
    r.clusterId = clusterId;
    r.hydrated = true;
    this.hydrateQueue.delete(address);
  }

  takeHydrationBatch(max = 500): string[] {
    const out: string[] = [];
    for (const a of this.hydrateQueue) {
      out.push(a);
      this.hydrateQueue.delete(a);
      if (out.length >= max) break;
    }
    return out;
  }

  setCluster(address: string, clusterId: number | null): void {
    const r = this.wallets.get(address);
    if (r) r.clusterId = clusterId;
  }

  profile(address: string): WalletProfile | undefined {
    const r = this.wallets.get(address);
    if (!r) return undefined;
    return profileFromTotals(add(r.base, r.delta), r.clusterId);
  }

  totals(address: string): WalletTotals | undefined {
    const r = this.wallets.get(address);
    return r ? add(r.base, r.delta) : undefined;
  }

  creator(address: string): CreatorProfile | undefined {
    const c = this.creators.get(address);
    if (!c) return undefined;
    return { tokensCreated: c.tokensCreated, tokensCompleted: c.tokensCompleted, quickDumps: c.quickDumps };
  }

  hydrateCreator(address: string, p: CreatorProfile & { firstCreatedAt: number; lastCreatedAt: number }): void {
    const c = this.creators.get(address);
    if (c) {
      c.tokensCreated = Math.max(c.tokensCreated, p.tokensCreated);
      c.tokensCompleted = Math.max(c.tokensCompleted, p.tokensCompleted);
      c.quickDumps = Math.max(c.quickDumps, p.quickDumps);
      return;
    }
    this.creators.set(address, { ...p, mints: new Map(), dirty: false });
  }

  onCreate(c: TokenCreated): void {
    let rec = this.creators.get(c.creator);
    if (!rec) {
      rec = { tokensCreated: 0, tokensCompleted: 0, quickDumps: 0, firstCreatedAt: c.ts, lastCreatedAt: c.ts, mints: new Map(), dirty: true };
      this.creators.set(c.creator, rec);
    }
    if (!rec.mints.has(c.mint)) {
      rec.tokensCreated++;
      rec.lastCreatedAt = Math.max(rec.lastCreatedAt, c.ts);
      rec.mints.set(c.mint, { createdAt: c.ts, dumped: false, completed: false });
      rec.dirty = true;
    }
    const w = this.record(c.creator, c.ts);
    w.delta.tokensCreated++;
  }

  onComplete(mint: string, creator: string | null): void {
    if (!creator) return;
    const rec = this.creators.get(creator);
    const m = rec?.mints.get(mint);
    if (rec && m && !m.completed) {
      m.completed = true;
      rec.tokensCompleted++;
      rec.dirty = true;
    }
  }

  /**
   * Apply a market trade. `tokenCreatedAt` enables early-entry and creator-dump detection.
   * Returns the position if this trade closed it.
   */
  onTrade(t: MarketTrade, tokenCreatedAt: number | null, creator: string | null): ClosedPosition | null {
    const sol = Number(t.solAmount) / 1e9;
    const fee = Number(t.feeLamports) / 1e9;
    const tokens = Number(t.tokenAmount) / 10 ** t.tokenDecimals;
    const w = this.record(t.trader, t.ts);
    const d = w.delta;
    d.trades++;
    d.volumeSol += sol;
    d.lastSeenAt = Math.max(d.lastSeenAt, t.ts);
    if (t.isBuy) d.buys++;
    else d.sells++;

    const key = `${t.trader}|${t.mint}`;
    let p = this.positions.get(key);
    if (!p) {
      if (!t.isBuy) return null; // selling tokens acquired before we observed them
      p = {
        address: t.trader,
        mint: t.mint,
        tokensBought: 0,
        tokensSold: 0,
        costSol: 0,
        proceedsSol: 0,
        buys: 0,
        sells: 0,
        firstBuyAt: null,
        firstBuyAgeSec: null,
        lastTradeAt: t.ts,
        dirty: true,
      };
      this.positions.set(key, p);
      d.tokensTraded++;
    }
    p.lastTradeAt = t.ts;
    p.dirty = true;
    if (t.isBuy) {
      p.buys++;
      p.tokensBought += tokens;
      p.costSol += sol + fee;
      if (p.firstBuyAt === null) {
        p.firstBuyAt = t.ts;
        p.firstBuyAgeSec = tokenCreatedAt !== null ? Math.max(0, (t.ts - tokenCreatedAt) / 1000) : null;
        if (p.firstBuyAgeSec !== null && p.firstBuyAgeSec <= 60) d.earlyEntries++;
        d.sumEntrySol += sol + fee;
      }
    } else {
      p.sells++;
      p.tokensSold += tokens;
      p.proceedsSol += Math.max(0, sol - fee);
    }

    // creator quick-dump: creator sold ≥ 80% of its buys within 10 minutes of creation
    if (creator && t.trader === creator && !t.isBuy && tokenCreatedAt !== null) {
      const rec = this.creators.get(creator);
      const m = rec?.mints.get(t.mint);
      if (rec && m && !m.dumped && t.ts - tokenCreatedAt <= 600_000 && p.tokensBought > 0 && p.tokensSold >= 0.8 * p.tokensBought) {
        m.dumped = true;
        rec.quickDumps++;
        rec.dirty = true;
      }
    }

    if (p.tokensBought > 0 && p.tokensSold >= 0.99 * p.tokensBought && p.costSol > 0) {
      this.positions.delete(key);
      const pnl = p.proceedsSol - p.costSol;
      const ret = p.proceedsSol / p.costSol - 1;
      d.closedPositions++;
      if (pnl > 0) d.winningPositions++;
      d.realizedPnlSol += pnl;
      d.sumReturn += ret;
      d.sumReturnSq += ret * ret;
      d.sumHoldSec += p.firstBuyAt !== null ? (t.ts - p.firstBuyAt) / 1000 : 0;
      const closed: ClosedPosition = { ...p, closedAt: t.ts, realizedPnlSol: pnl, returnPct: ret };
      this.closedQueue.push(closed);
      return closed;
    }
    return null;
  }

  /** Positions changed since the last call (for DB upsert). */
  takeDirtyPositions(): OpenPosition[] {
    const out: OpenPosition[] = [];
    for (const p of this.positions.values()) {
      if (p.dirty) {
        out.push({ ...p });
        p.dirty = false;
      }
    }
    return out;
  }

  takeClosedPositions(): ClosedPosition[] {
    return this.closedQueue.splice(0);
  }

  /** Deltas to persist; after the call the deltas are folded into base. */
  takeWalletDeltas(): { address: string; delta: WalletTotals; clusterId: number | null }[] {
    const out: { address: string; delta: WalletTotals; clusterId: number | null }[] = [];
    for (const [address, r] of this.wallets) {
      if (r.delta.trades === 0 && r.delta.tokensCreated === 0) continue;
      out.push({ address, delta: r.delta, clusterId: r.clusterId });
      r.base = add(r.base, r.delta);
      r.delta = emptyTotals(r.base.lastSeenAt);
    }
    return out;
  }

  takeDirtyCreators(): ({ address: string } & Omit<CreatorRecord, "mints" | "dirty">)[] {
    const out: ({ address: string } & Omit<CreatorRecord, "mints" | "dirty">)[] = [];
    for (const [address, c] of this.creators) {
      if (!c.dirty) continue;
      c.dirty = false;
      out.push({
        address,
        tokensCreated: c.tokensCreated,
        tokensCompleted: c.tokensCompleted,
        quickDumps: c.quickDumps,
        firstCreatedAt: c.firstCreatedAt,
        lastCreatedAt: c.lastCreatedAt,
      });
    }
    return out;
  }

  /**
   * Memory bound: forget idle open positions and low-value idle wallets (their totals are in the DB).
   * Wallets with enough closed positions to carry evidence stay in memory.
   */
  evict(now: number, positionIdleMs = 6 * 3_600_000, walletIdleMs = 24 * 3_600_000): void {
    for (const [k, p] of this.positions) if (now - p.lastTradeAt > positionIdleMs) this.positions.delete(k);
    for (const [a, r] of this.wallets) {
      const total = add(r.base, r.delta);
      const pendingDelta = r.delta.trades > 0 || r.delta.tokensCreated > 0;
      if (!pendingDelta && now - total.lastSeenAt > walletIdleMs && total.closedPositions < 5) this.wallets.delete(a);
    }
    for (const [addr, c] of this.creators) {
      for (const [mint, m] of c.mints) if (now - m.createdAt > 24 * 3_600_000) c.mints.delete(mint);
      if (c.mints.size === 0 && !c.dirty && now - c.lastCreatedAt > 7 * 24 * 3_600_000) this.creators.delete(addr);
    }
  }
}
