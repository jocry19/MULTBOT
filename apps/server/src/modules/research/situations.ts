import { fitScaler, kmeans, nearest, transform, type Scaler } from "../stats/ml.js";
import { mean, median, quantile } from "../stats/stats.js";
import type { SampleOutcome } from "./outcomes.js";

/**
 * Historical situation analysis:
 *  - clusters of similar situations (k-means on robustly scaled features) with outcome statistics
 *  - analogue search: "the current situation resembles N historical situations; afterwards …"
 * Nothing here implies a guaranteed outcome — it summarises what happened in comparable cases.
 */

/** Robust, broadly available features describing a situation. */
export const SITUATION_FEATURES = [
  "log_age",
  "log_mcap",
  "bonding_progress",
  "ret_60s",
  "ret_5m",
  "volume_60s",
  "volume_accel_60s",
  "buy_ratio_60s",
  "trades_60s",
  "unique_buyers_60s",
  "new_buyers_60s",
  "seller_buyer_ratio_60s",
  "volatility_60s",
  "max_buy_share_60s",
  "liquidity_sol",
  "top10_share",
  "holder_growth_60s",
  "smart_buyers_60s",
  "fresh_wallet_share_60s",
  "drawdown_from_ath",
];

export interface SituationSample {
  id: number;
  ts: number;
  mint: string;
  venue: string;
  ageSec: number;
  features: Record<string, number>;
  outcome: SampleOutcome;
}

export interface OutcomeSummary {
  n: number;
  mean: number;
  median: number;
  positive: number;
  negative: number;
  winRate: number;
  worst: number;
  best: number;
  p10: number;
  p90: number;
  maxRunupMedian: number;
  maxDrawdownMedian: number;
  timeToPeakMedianSec: number;
}

export function summarize(outcomes: SampleOutcome[], horizon: string): OutcomeSummary {
  const hs = outcomes.map((o) => o.horizons[horizon]).filter((h): h is NonNullable<typeof h> => h !== undefined && !h.gap);
  const rets = hs.map((h) => h.ret);
  return {
    n: rets.length,
    mean: mean(rets),
    median: median(rets),
    positive: rets.filter((r) => r > 0).length,
    negative: rets.filter((r) => r <= 0).length,
    winRate: rets.length > 0 ? rets.filter((r) => r > 0).length / rets.length : 0,
    worst: rets.length > 0 ? Math.min(...rets) : 0,
    best: rets.length > 0 ? Math.max(...rets) : 0,
    p10: quantile(rets, 0.1),
    p90: quantile(rets, 0.9),
    maxRunupMedian: median(hs.map((h) => h.maxRunup)),
    maxDrawdownMedian: median(hs.map((h) => h.maxDrawdown)),
    timeToPeakMedianSec: median(hs.map((h) => h.tPeakSec)),
  };
}

export interface SituationCluster {
  index: number;
  size: number;
  centroid: Record<string, number>;
  description: { feature: string; z: number; direction: "high" | "low" }[];
  stats: Record<string, OutcomeSummary>;
}

export function clusterSituations(samples: SituationSample[], k: number, horizons: string[], seed = 7): { scaler: Scaler; clusters: SituationCluster[] } {
  const features = SITUATION_FEATURES.filter((f) => samples.filter((s) => s.features[f] !== undefined).length >= samples.length * 0.5);
  const scaler = fitScaler(samples.map((s) => s.features), features);
  const X = samples.map((s) => transform(scaler, s.features));
  const km = kmeans(X, k, { seed, iterations: 60 });
  const clusters: SituationCluster[] = km.centroids.map((c, idx) => {
    const members = samples.filter((_, i) => km.assignment[i] === idx);
    const centroid: Record<string, number> = {};
    const description: SituationCluster["description"] = [];
    features.forEach((f, j) => {
      const z = c[j] as number;
      centroid[f] = (scaler.center[j] as number) + z * (scaler.scale[j] as number);
      description.push({ feature: f, z, direction: z >= 0 ? "high" : "low" });
    });
    description.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const stats: Record<string, OutcomeSummary> = {};
    for (const h of horizons) stats[h] = summarize(members.map((m) => m.outcome), h);
    return { index: idx, size: members.length, centroid, description: description.slice(0, 6), stats };
  });
  return { scaler, clusters: clusters.filter((c) => c.size > 0).sort((a, b) => b.size - a.size) };
}

export interface AnalogueResult {
  similarSituations: number;
  similarity: number;
  horizons: Record<string, OutcomeSummary>;
  examples: { mint: string; ts: number; ret300: number | null }[];
}

/** In-memory analogue index (rebuilt periodically from labelled samples). */
export class AnalogueIndex {
  private scaler: Scaler | null = null;
  private X: Float64Array[] = [];
  private samples: SituationSample[] = [];
  private radius2 = 0;
  builtAt = 0;

  get size(): number {
    return this.samples.length;
  }

  build(samples: SituationSample[]): void {
    this.samples = samples;
    const features = SITUATION_FEATURES.filter((f) => samples.filter((s) => s.features[f] !== undefined).length >= samples.length * 0.5);
    this.scaler = fitScaler(samples.map((s) => s.features), features);
    this.X = samples.map((s) => transform(this.scaler as Scaler, s.features));
    // radius: median distance to the 20th neighbour on a subsample
    const probe = this.X.filter((_, i) => i % Math.max(1, Math.floor(this.X.length / 200)) === 0).slice(0, 200);
    const d = probe.map((q) => nearest(this.X, q, 21).at(-1)?.d2 ?? 0).sort((a, b) => a - b);
    this.radius2 = d[Math.floor(d.length / 2)] ?? 1;
    this.builtAt = Date.now();
  }

  query(features: Record<string, number>, venue: string, ageSec: number, horizons: string[], k = 300): AnalogueResult | null {
    if (!this.scaler || this.samples.length === 0) return null;
    const q = transform(this.scaler, features);
    const ageLo = ageSec / 3;
    const ageHi = ageSec * 3 + 30;
    const nn = nearest(this.X, q, k, (i) => {
      const s = this.samples[i] as SituationSample;
      return s.venue === venue && s.ageSec >= ageLo && s.ageSec <= ageHi;
    }).filter((x) => x.d2 <= this.radius2 * 1.5);
    const matched = nn.map((x) => this.samples[x.index] as SituationSample);
    const horizonsOut: Record<string, OutcomeSummary> = {};
    for (const h of horizons) horizonsOut[h] = summarize(matched.map((m) => m.outcome), h);
    const similarity = nn.length > 0 ? mean(nn.map((x) => Math.exp(-x.d2 / (2 * Math.max(1e-9, this.radius2))))) : 0;
    return {
      similarSituations: matched.length,
      similarity,
      horizons: horizonsOut,
      examples: matched.slice(0, 10).map((m) => ({ mint: m.mint, ts: m.ts, ret300: m.outcome.horizons["300"]?.ret ?? null })),
    };
  }
}
