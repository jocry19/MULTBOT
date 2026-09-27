import type { RegimeDimension, RegimeLevel } from "@multbot/shared";
import type { FeatureVector } from "../features/types.js";
import type { MarketState } from "../market/marketState.js";

/**
 * Market regime detection. Market-wide metrics are compared with this system's own history of the
 * same metrics (percentile rank over a sliding window, default 7 days of 1-minute observations), so
 * "high activity" always means "high relative to what this market usually looks like".
 */

export interface RegimeMetrics {
  trades_5m: number;
  volume_5m: number;
  new_tokens_5m: number;
  migrations_1h: number;
  active_tokens_5m: number;
  /** Share of active tokens with positive 5m return. */
  breadth: number;
  /** Median absolute 5m log return across active tokens. */
  volatility: number;
  /** Buy share of market volume in 5m. */
  buy_share_5m: number;
  /** Median liquidity (SOL) of active tokens. */
  median_liquidity: number;
}

export interface RegimeState {
  ts: number;
  metrics: RegimeMetrics;
  percentiles: Record<keyof RegimeMetrics, number>;
  levels: Record<RegimeDimension, RegimeLevel>;
  label: string;
  /** Number of historical observations backing the percentiles. */
  historySize: number;
}

const METRIC_KEYS: (keyof RegimeMetrics)[] = [
  "trades_5m",
  "volume_5m",
  "new_tokens_5m",
  "migrations_1h",
  "active_tokens_5m",
  "breadth",
  "volatility",
  "buy_share_5m",
  "median_liquidity",
];

export function levelOf(pct: number): RegimeLevel {
  if (pct < 0.2) return "low";
  if (pct < 0.8) return "normal";
  if (pct < 0.95) return "high";
  return "extreme";
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function computeRegimeMetrics(market: MarketState, now: number): RegimeMetrics {
  const w5 = market.window(now, 5 * 60_000);
  const w60 = market.window(now, 60 * 60_000);
  const active = market.activeTokens(now, 5 * 60_000);
  let up = 0;
  const absRets: number[] = [];
  const liqs: number[] = [];
  for (const t of active) {
    const p0 = t.tape.priceAt(now - 5 * 60_000);
    const p1 = t.tape.priceAt(now) ?? t.lastPrice;
    if (p0 && p0 > 0 && p1 > 0) {
      const r = Math.log(p1 / p0);
      absRets.push(Math.abs(r));
      if (r > 0) up++;
    }
    liqs.push(t.liquiditySol);
  }
  return {
    trades_5m: w5.trades,
    volume_5m: w5.volSol,
    new_tokens_5m: w5.newTokens,
    migrations_1h: w60.migrations,
    active_tokens_5m: active.length,
    breadth: absRets.length > 0 ? up / absRets.length : 0.5,
    volatility: median(absRets),
    buy_share_5m: w5.volSol > 0 ? w5.buyVolSol / w5.volSol : 0.5,
    median_liquidity: median(liqs),
  };
}

export class RegimeEngine {
  private readonly history: Record<keyof RegimeMetrics, number[]>;
  private current: RegimeState | null = null;

  constructor(private readonly maxHistory = 7 * 24 * 60) {
    this.history = Object.fromEntries(METRIC_KEYS.map((k) => [k, []])) as unknown as Record<keyof RegimeMetrics, number[]>;
  }

  get state(): RegimeState | null {
    return this.current;
  }

  private pct(key: keyof RegimeMetrics, v: number): number {
    const h = this.history[key];
    if (h.length < 30) return 0.5; // not enough history → neutral
    let below = 0;
    let equal = 0;
    for (const x of h) {
      if (x < v) below++;
      else if (x === v) equal++;
    }
    return (below + equal / 2) / h.length;
  }

  /** Classify current metrics against history, then add them to history. */
  update(metrics: RegimeMetrics, now: number): RegimeState {
    const p = Object.fromEntries(METRIC_KEYS.map((k) => [k, this.pct(k, metrics[k])])) as Record<keyof RegimeMetrics, number>;
    const activityPct = (p.trades_5m + p.new_tokens_5m + p.active_tokens_5m) / 3;
    const levels: Record<RegimeDimension, RegimeLevel> = {
      activity: levelOf(activityPct),
      volatility: levelOf(p.volatility),
      liquidity: levelOf((p.median_liquidity + p.volume_5m) / 2),
      breadth: levelOf(p.breadth),
      flow: levelOf(p.buy_share_5m),
    };
    const state: RegimeState = {
      ts: now,
      metrics,
      percentiles: p,
      levels,
      label: labelRegime(levels),
      historySize: this.history.trades_5m.length,
    };
    for (const k of METRIC_KEYS) {
      const h = this.history[k];
      h.push(metrics[k]);
      if (h.length > this.maxHistory) h.shift();
    }
    this.current = state;
    return state;
  }

  /** Market features added to every token feature vector (prefixed mkt_ by the FeatureEngine). */
  features(): FeatureVector {
    const s = this.current;
    if (!s) return {};
    const lv = (l: RegimeLevel) => ({ low: 0, normal: 1, high: 2, extreme: 3 })[l];
    return {
      activity_level: lv(s.levels.activity),
      volatility_level: lv(s.levels.volatility),
      liquidity_level: lv(s.levels.liquidity),
      breadth_level: lv(s.levels.breadth),
      flow_level: lv(s.levels.flow),
      trades_5m_pct: s.percentiles.trades_5m,
      new_tokens_5m: s.metrics.new_tokens_5m,
      breadth: s.metrics.breadth,
      buy_share_5m: s.metrics.buy_share_5m,
    };
  }

  snapshot(): Record<string, number[]> {
    return this.history as unknown as Record<string, number[]>;
  }

  restore(snap: Record<string, number[]> | null | undefined): void {
    if (!snap) return;
    for (const k of METRIC_KEYS) {
      const arr = snap[k];
      if (Array.isArray(arr)) this.history[k] = arr.slice(-this.maxHistory);
    }
  }
}

export function labelRegime(l: Record<RegimeDimension, RegimeLevel>): string {
  const hi = (x: RegimeLevel) => x === "high" || x === "extreme";
  if (l.flow === "low" && hi(l.volatility)) return "panic_selling";
  if (l.activity === "extreme") return "extreme_activity";
  if (hi(l.activity) && hi(l.breadth) && l.flow !== "low") return "speculative_expansion";
  if (hi(l.activity)) return "broad_market_expansion";
  if (l.activity === "low" && l.breadth === "low") return "market_contraction";
  if (l.activity === "low") return "low_activity";
  if (hi(l.volatility)) return "high_volatility";
  if (l.volatility === "low") return "low_volatility";
  if (l.liquidity === "low") return "low_liquidity";
  if (hi(l.liquidity)) return "high_liquidity";
  return "normal";
}
