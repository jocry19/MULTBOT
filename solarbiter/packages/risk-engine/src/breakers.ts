import { CIRCUIT_BREAKERS, LIVE_ONLY_BREAKERS, type CircuitBreakerId, type TradeMode } from "@solarbiter/shared";

/**
 * Breakers that protect money directly. Once open they stay open until the user resets them —
 * the condition going away is not enough (it may come back with the next trade).
 */
export const MANUAL_RESET_BREAKERS: CircuitBreakerId[] = ["WALLET_MISMATCH", "BALANCE_MISMATCH", "TX_FAILURE_SPIKE", "UNEXPECTED_SLIPPAGE", "SECURITY_FAILURE"];

/** Healthy time required before an automatic breaker closes again. */
export const AUTO_CLOSE_AFTER_MS = 30_000;

export interface BreakerState {
  id: CircuitBreakerId;
  open: boolean;
  reason: string | null;
  openedAt: number | null;
  /** Healthy since (auto breakers only). */
  clearSince: number | null;
  manualReset: boolean;
  trips: number;
}

export type BreakerChange = { id: CircuitBreakerId; open: boolean; reason: string | null; by: string };

export class BreakerBoard {
  private readonly states = new Map<CircuitBreakerId, BreakerState>();
  private readonly listeners = new Set<(c: BreakerChange) => void>();

  constructor(private readonly now: () => number = Date.now) {
    for (const id of CIRCUIT_BREAKERS) {
      this.states.set(id, { id, open: false, reason: null, openedAt: null, clearSince: null, manualReset: MANUAL_RESET_BREAKERS.includes(id), trips: 0 });
    }
  }

  onChange(fn: (c: BreakerChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: BreakerChange): void {
    for (const l of this.listeners) l(c);
  }

  trip(id: CircuitBreakerId, reason: string): void {
    const s = this.states.get(id) as BreakerState;
    s.clearSince = null;
    if (s.open) {
      s.reason = reason;
      return;
    }
    s.open = true;
    s.reason = reason;
    s.openedAt = this.now();
    s.trips++;
    this.emit({ id, open: true, reason, by: "system" });
  }

  /**
   * Feed the current condition of an automatic breaker. Opens immediately when bad; closes only
   * after the condition has been healthy for AUTO_CLOSE_AFTER_MS. Manual breakers are only opened.
   */
  report(id: CircuitBreakerId, bad: boolean, reason = ""): void {
    const s = this.states.get(id) as BreakerState;
    if (bad) {
      this.trip(id, reason || id);
      return;
    }
    if (!s.open || s.manualReset) return;
    const t = this.now();
    if (s.clearSince === null) s.clearSince = t;
    if (t - s.clearSince >= AUTO_CLOSE_AFTER_MS) this.close(id, "auto-recovery");
  }

  /** Manual reset by the user (all breakers) — logged by the caller. */
  reset(id: CircuitBreakerId, actor: string): boolean {
    const s = this.states.get(id) as BreakerState;
    if (!s.open) return false;
    this.close(id, actor);
    return true;
  }

  private close(id: CircuitBreakerId, by: string): void {
    const s = this.states.get(id) as BreakerState;
    s.open = false;
    s.reason = null;
    s.openedAt = null;
    s.clearSince = null;
    this.emit({ id, open: false, reason: null, by });
  }

  isOpen(id: CircuitBreakerId): boolean {
    return this.states.get(id)?.open === true;
  }

  open(): CircuitBreakerId[] {
    return [...this.states.values()].filter((s) => s.open).map((s) => s.id);
  }

  /** Breakers that block trading in this mode (live-only breakers do not stop paper learning). */
  blocking(mode: TradeMode): CircuitBreakerId[] {
    return this.open().filter((id) => mode === "live" || !LIVE_ONLY_BREAKERS.includes(id));
  }

  snapshot(): BreakerState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  /** Restore persisted state after a restart: open breakers stay open. */
  restore(states: Partial<BreakerState>[]): void {
    for (const r of states) {
      if (!r.id || !this.states.has(r.id)) continue;
      const s = this.states.get(r.id) as BreakerState;
      if (r.open) {
        s.open = true;
        s.reason = r.reason ?? "restored after restart";
        s.openedAt = r.openedAt ?? this.now();
        s.trips = r.trips ?? s.trips;
      }
    }
  }
}

/** Thresholds for the automatic breaker conditions. */
export const BREAKER_THRESHOLDS = {
  latencySpikeMs: 3_000,
  staleStateFactor: 10,
  staleStateMinMs: 20_000,
  priceMove5mPct: 3,
  slippageDeviationBps: 25,
  slippageWindow: 5,
  txFailureWindow: 10,
  txFailureMax: 3,
} as const;

export interface HealthInputs {
  rpcHealthy: boolean;
  rpcLatencyMs: number | null;
  quoteProviderAvailable: boolean;
  poolStateAgeMs: number | null;
  poolPollMs: number;
  dexUnavailable: string[];
  /** SOL/EUR change over the last 5 minutes (%), null if unknown. */
  solEurChange5mPct: number | null;
  /** Realised − expected output of the latest re-quotes / trades (bps, positive = worse). */
  slippageDeviationsBps: number[];
  /** Latest live attempts, true = failed. */
  recentTxFailures: boolean[];
  jitoHealthy: boolean | null;
  databaseHealthy: boolean;
  redisHealthy: boolean;
  walletMatches: boolean | null;
  balanceMatches: boolean | null;
}

/** Evaluate every automatic condition and feed the board. */
export function evaluateBreakers(board: BreakerBoard, h: HealthInputs): void {
  const t = BREAKER_THRESHOLDS;
  board.report("RPC_OUTAGE", !h.rpcHealthy, "no healthy RPC endpoint");
  board.report("LATENCY_SPIKE", h.rpcLatencyMs !== null && h.rpcLatencyMs > t.latencySpikeMs, `RPC latency ${h.rpcLatencyMs} ms`);
  board.report("QUOTE_OUTAGE", !h.quoteProviderAvailable, "quote provider unavailable");
  const staleLimit = Math.max(t.staleStateMinMs, h.poolPollMs * t.staleStateFactor);
  board.report("STALE_QUOTES", h.poolStateAgeMs !== null && h.poolStateAgeMs > staleLimit, `pool state ${h.poolStateAgeMs} ms old`);
  board.report("DEX_OUTAGE", h.dexUnavailable.length > 0, `unavailable: ${h.dexUnavailable.join(", ")}`);
  board.report("UNEXPECTED_PRICE_MOVE", h.solEurChange5mPct !== null && Math.abs(h.solEurChange5mPct) > t.priceMove5mPct, `SOL/EUR moved ${h.solEurChange5mPct?.toFixed(2)} % in 5 min`);
  const dev = h.slippageDeviationsBps.slice(-t.slippageWindow);
  if (dev.length >= t.slippageWindow) {
    const sorted = [...dev].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    if (median > t.slippageDeviationBps) board.trip("UNEXPECTED_SLIPPAGE", `median slippage deviation ${median.toFixed(1)} bps over the last ${dev.length}`);
  }
  const fails = h.recentTxFailures.slice(-t.txFailureWindow).filter(Boolean).length;
  if (fails >= t.txFailureMax) board.trip("TX_FAILURE_SPIKE", `${fails} failed transactions in the last ${t.txFailureWindow}`);
  if (h.jitoHealthy !== null) board.report("JITO_PROBLEM", !h.jitoHealthy, "Jito block engine unavailable");
  board.report("DATABASE_FAILURE", !h.databaseHealthy, "database unavailable");
  board.report("REDIS_FAILURE", !h.redisHealthy, "Redis unavailable");
  if (h.walletMatches === false) board.trip("WALLET_MISMATCH", "signer does not match the configured wallet");
  if (h.balanceMatches === false) board.trip("BALANCE_MISMATCH", "on-chain balance differs from the internal ledger");
}
