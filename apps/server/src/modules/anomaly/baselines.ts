import type { FeatureVector } from "../features/types.js";

/**
 * Context-conditional baselines ("what is unusual for THIS token at THIS age in THIS venue?").
 *
 * For each (feature, context) a sliding window of recent observations is kept. Robust statistics
 * (median, MAD, quantile grid) are recomputed periodically and used to transform raw values into
 *   <feature>__ctxz    robust z-score  (v − median) / (1.4826 · MAD)
 *   <feature>__ctxpct  percentile rank within the context (0 … 1)
 * Observations are added only after the transform was computed, so values never see themselves
 * (causal in both live and replay).
 */

export const AGE_BUCKETS_SEC = [30, 60, 120, 300, 900, 3600, 6 * 3600, Infinity] as const;

export function ageBucket(ageSec: number): string {
  const idx = AGE_BUCKETS_SEC.findIndex((b) => ageSec < b);
  const upper = AGE_BUCKETS_SEC[idx] ?? Infinity;
  return upper === Infinity ? "6h+" : `<${upper}s`;
}

export function contextKey(ageSec: number, venue: "pump_curve" | "pump_amm"): string {
  return `${venue}|${ageBucket(ageSec)}`;
}

/** Features that get contextual transforms. */
export const CONTEXT_FEATURES = [
  "volume_10s",
  "volume_60s",
  "volume_5m",
  "trades_60s",
  "volume_accel_60s",
  "trade_accel_30s",
  "net_flow_60s",
  "buy_ratio_60s",
  "unique_buyers_60s",
  "unique_sellers_60s",
  "new_buyers_60s",
  "buyer_accel",
  "holder_growth_60s",
  "holder_growth_5m",
  "holders",
  "ret_30s",
  "ret_60s",
  "ret_5m",
  "volatility_60s",
  "max_buy_sol_60s",
  "max_sell_sol_60s",
  "liquidity_sol",
  "top10_share",
  "smart_buy_sol_60s",
  "max_buyers_same_slot_60s",
  "volume_to_liq_5m",
] as const;

const WINDOW = 2000;
const DEFAULT_MIN_OBS = 500;
const GRID = 21; // quantiles 0, 5, …, 100 %

interface Stats {
  n: number;
  median: number;
  mad: number;
  grid: number[];
}

export interface BaselineSnapshot {
  version: 1;
  stats: Record<string, Stats>;
}

export class ContextBaselines {
  private readonly windows = new Map<string, { buf: Float64Array; count: number; pos: number }>();
  private stats = new Map<string, Stats>();
  private dirty = 0;

  constructor(
    private readonly features: readonly string[] = CONTEXT_FEATURES,
    /** Observations required before a context produces scores (avoids cold-start false anomalies). */
    private readonly minObs = DEFAULT_MIN_OBS,
  ) {}

  private key(feature: string, ctx: string): string {
    return `${feature}@${ctx}`;
  }

  observe(f: FeatureVector, ctx: string): void {
    for (const feat of this.features) {
      const v = f[feat];
      if (v === undefined) continue;
      for (const c of [ctx]) {
        const k = this.key(feat, c);
        let w = this.windows.get(k);
        if (!w) {
          w = { buf: new Float64Array(WINDOW), count: 0, pos: 0 };
          this.windows.set(k, w);
        }
        w.buf[w.pos] = v;
        w.pos = (w.pos + 1) % WINDOW;
        if (w.count < WINDOW) w.count++;
      }
    }
    this.dirty++;
  }

  get pendingObservations(): number {
    return this.dirty;
  }

  /** Recompute robust statistics from the sliding windows. */
  refresh(): void {
    const next = new Map(this.stats);
    for (const [k, w] of this.windows) {
      if (w.count < this.minObs) continue;
      const vals = Array.from(w.buf.subarray(0, w.count)).sort((a, b) => a - b);
      const q = (p: number) => {
        const idx = p * (vals.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return (vals[lo] as number) + ((vals[hi] as number) - (vals[lo] as number)) * (idx - lo);
      };
      const median = q(0.5);
      const dev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
      const mad = dev[Math.floor(dev.length / 2)] ?? 0;
      const grid = Array.from({ length: GRID }, (_, i) => q(i / (GRID - 1)));
      next.set(k, { n: w.count, median, mad, grid });
    }
    this.stats = next;
    this.dirty = 0;
  }

  private statsFor(feature: string, ctx: string): Stats | undefined {
    // context-specific only: comparing a 20s-old token with the whole market would be meaningless
    return this.stats.get(this.key(feature, ctx));
  }

  /** Adds __ctxz and __ctxpct features (in place). */
  transform(f: FeatureVector, ctx: string): FeatureVector {
    for (const feat of this.features) {
      const v = f[feat];
      if (v === undefined) continue;
      const s = this.statsFor(feat, ctx);
      if (!s) continue;
      // Scale floor: MAD, else interquantile spread, else relative to median → avoids infinite z on sparse features
      const spread = s.mad > 0 ? 1.4826 * s.mad : ((s.grid[19] ?? 0) - (s.grid[1] ?? 0)) / 3.29 || Math.abs(s.median) * 0.1 || 1e-6;
      const z = (v - s.median) / spread;
      f[`${feat}__ctxz`] = Math.max(-50, Math.min(50, z));
      f[`${feat}__ctxpct`] = percentile(s.grid, v);
    }
    return f;
  }

  snapshot(): BaselineSnapshot {
    return { version: 1, stats: Object.fromEntries(this.stats) };
  }

  restore(snap: BaselineSnapshot | null | undefined): void {
    if (!snap || snap.version !== 1) return;
    this.stats = new Map(Object.entries(snap.stats));
  }

  get contexts(): number {
    return this.stats.size;
  }
}

function percentile(grid: number[], v: number): number {
  if (grid.length === 0) return 0.5;
  if (v <= (grid[0] as number)) return 0;
  if (v >= (grid[grid.length - 1] as number)) return 1;
  for (let i = 1; i < grid.length; i++) {
    const hi = grid[i] as number;
    const lo = grid[i - 1] as number;
    if (v <= hi) {
      const frac = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      return (i - 1 + frac) / (grid.length - 1);
    }
  }
  return 1;
}
