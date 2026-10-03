import { lamportsToEur, type TradeMode } from "@solarbiter/shared";

export interface ClosedTrade {
  id: string;
  mode: TradeMode;
  closedAt: number;
  sizeEur: number;
  netLamports: bigint;
  netEur: number;
  /** null = outcome unknown (e.g. re-quote unavailable) — excluded from statistics. */
  success: boolean | null;
}

export interface PortfolioSnapshot {
  mode: TradeMode;
  balanceLamports: string;
  startingLamports: string;
  equityEur: number;
  realizedEur: number;
  pnlTodayEur: number;
  drawdownEur: number;
  maxDrawdownEur: number;
  trades: number;
  wins: number;
  losses: number;
  failures: number;
  openTrades: number;
  consecutiveFailures: number;
  lossStreak: number;
  lastTradeSizeEur: number | null;
  lastTradeLost: boolean;
  expectancyEur: number | null;
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Portfolio of ONE mode. Paper and live each have their own instance and their own database
 * table — they are never mixed. PnL and drawdown are measured on realised trade results (EUR at
 * trade time); SOL price moves of the capital itself are not trading results.
 */
export class Portfolio {
  balanceLamports: bigint;
  private realizedEur = 0;
  private peakRealizedEur = 0;
  private maxDrawdown = 0;
  private today = "";
  private todayEur = 0;
  private readonly recent: ClosedTrade[] = [];
  openTrades = 0;
  consecutiveFailures = 0;
  lossStreak = 0;
  lastTradeSizeEur: number | null = null;
  lastTradeLost = false;
  trades = 0;
  wins = 0;
  losses = 0;
  failures = 0;

  constructor(
    readonly mode: TradeMode,
    readonly startingLamports: bigint,
    private readonly now: () => number = Date.now,
  ) {
    this.balanceLamports = startingLamports;
  }

  open(): void {
    this.openTrades++;
  }

  /** Release an open slot without a trade result (e.g. aborted before sending). */
  abort(): void {
    this.openTrades = Math.max(0, this.openTrades - 1);
  }

  close(t: ClosedTrade): void {
    this.openTrades = Math.max(0, this.openTrades - 1);
    this.apply(t);
  }

  /** Rebuild from persisted trades (oldest first) after a restart. */
  restore(trades: ClosedTrade[]): void {
    for (const t of trades) this.apply(t);
  }

  private apply(t: ClosedTrade): void {
    this.balanceLamports += t.netLamports;
    const day = utcDay(t.closedAt);
    if (day !== this.today) {
      this.today = day;
      this.todayEur = 0;
    }
    this.todayEur += t.netEur;
    this.realizedEur += t.netEur;
    this.peakRealizedEur = Math.max(this.peakRealizedEur, this.realizedEur);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakRealizedEur - this.realizedEur);
    if (t.success === false) {
      this.failures++;
      this.consecutiveFailures++;
    } else if (t.success === true) {
      this.consecutiveFailures = 0;
    }
    if (t.success !== null) {
      this.trades++;
      if (t.netLamports < 0n) {
        this.losses++;
        this.lossStreak++;
        this.lastTradeLost = true;
      } else if (t.netLamports > 0n) {
        this.wins++;
        this.lossStreak = 0;
        this.lastTradeLost = false;
      }
      this.lastTradeSizeEur = t.sizeEur;
      this.recent.push(t);
      if (this.recent.length > 500) this.recent.shift();
    }
  }

  pnlTodayEur(): number {
    return utcDay(this.now()) === this.today ? this.todayEur : 0;
  }

  drawdownEur(): number {
    return this.peakRealizedEur - this.realizedEur;
  }

  /** Mean net result of recent trades with a known outcome (null below 10 trades). */
  expectancyEur(): number | null {
    const known = this.recent.filter((t) => t.success !== null);
    if (known.length < 10) return null;
    return known.reduce((a, t) => a + t.netEur, 0) / known.length;
  }

  equityEur(solEur: number): number {
    return lamportsToEur(this.balanceLamports, solEur);
  }

  snapshot(solEur: number): PortfolioSnapshot {
    return {
      mode: this.mode,
      balanceLamports: this.balanceLamports.toString(),
      startingLamports: this.startingLamports.toString(),
      equityEur: this.equityEur(solEur),
      realizedEur: this.realizedEur,
      pnlTodayEur: this.pnlTodayEur(),
      drawdownEur: this.drawdownEur(),
      maxDrawdownEur: this.maxDrawdown,
      trades: this.trades,
      wins: this.wins,
      losses: this.losses,
      failures: this.failures,
      openTrades: this.openTrades,
      consecutiveFailures: this.consecutiveFailures,
      lossStreak: this.lossStreak,
      lastTradeSizeEur: this.lastTradeSizeEur,
      lastTradeLost: this.lastTradeLost,
      expectancyEur: this.expectancyEur(),
    };
  }
}
