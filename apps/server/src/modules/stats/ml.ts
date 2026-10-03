import { quantileSorted, seededRandom } from "./stats.js";

/**
 * Small, dependency-free ML helpers: robust scaling, k-means (k-means++ init), k-nearest neighbours.
 */

export interface Scaler {
  features: string[];
  center: number[];
  scale: number[];
}

/** Robust scaler (median / IQR) fitted on rows of feature records; missing values are ignored. */
export function fitScaler(rows: Record<string, number>[], features: string[]): Scaler {
  const center: number[] = [];
  const scale: number[] = [];
  for (const f of features) {
    const vals = rows.map((r) => r[f]).filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
    const med = quantileSorted(vals, 0.5);
    const iqr = quantileSorted(vals, 0.75) - quantileSorted(vals, 0.25);
    center.push(med);
    scale.push(iqr > 0 ? iqr / 1.349 : Math.max(1e-9, Math.abs(med) * 0.1 || 1));
  }
  return { features, center, scale };
}

/** Scaled vector; missing features become 0 (= the median), values clipped to ±6. */
export function transform(s: Scaler, row: Record<string, number>): Float64Array {
  const out = new Float64Array(s.features.length);
  for (let i = 0; i < s.features.length; i++) {
    const v = row[s.features[i] as string];
    if (v === undefined || !Number.isFinite(v)) continue;
    const z = (v - (s.center[i] as number)) / (s.scale[i] as number);
    out[i] = Math.max(-6, Math.min(6, z));
  }
  return out;
}

export function sqDist(a: Float64Array, b: Float64Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] as number) - (b[i] as number);
    d += x * x;
  }
  return d;
}

export interface KMeansResult {
  centroids: Float64Array[];
  assignment: Int32Array;
  inertia: number;
}

export function kmeans(data: Float64Array[], k: number, opts: { iterations?: number; seed?: number } = {}): KMeansResult {
  const n = data.length;
  const dim = data[0]?.length ?? 0;
  const rnd = seededRandom(opts.seed ?? 42);
  k = Math.max(1, Math.min(k, n));
  // k-means++ initialisation
  const centroids: Float64Array[] = [];
  centroids.push(Float64Array.from(data[Math.floor(rnd() * n)] as Float64Array));
  const d2 = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    let sum = 0;
    const last = centroids[centroids.length - 1] as Float64Array;
    for (let i = 0; i < n; i++) {
      d2[i] = Math.min(d2[i] as number, sqDist(data[i] as Float64Array, last));
      sum += d2[i] as number;
    }
    let r = rnd() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d2[i] as number;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(Float64Array.from(data[pick] as Float64Array));
  }
  const assignment = new Int32Array(n);
  let inertia = 0;
  for (let it = 0; it < (opts.iterations ?? 50); it++) {
    let changed = 0;
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(data[i] as Float64Array, centroids[c] as Float64Array);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignment[i] !== best) changed++;
      assignment[i] = best;
      inertia += bestD;
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignment[i] as number;
      counts[c] = (counts[c] as number) + 1;
      const row = data[i] as Float64Array;
      const s = sums[c] as Float64Array;
      for (let j = 0; j < dim; j++) s[j] = (s[j] as number) + (row[j] as number);
    }
    for (let c = 0; c < k; c++) {
      const cnt = counts[c] as number;
      if (cnt === 0) continue;
      const s = sums[c] as Float64Array;
      for (let j = 0; j < dim; j++) s[j] = (s[j] as number) / cnt;
      centroids[c] = s;
    }
    if (it > 0 && changed === 0) break;
  }
  return { centroids, assignment, inertia };
}

/** Indices and squared distances of the k nearest rows. */
export function nearest(data: Float64Array[], query: Float64Array, k: number, filter?: (i: number) => boolean): { index: number; d2: number }[] {
  const best: { index: number; d2: number }[] = [];
  for (let i = 0; i < data.length; i++) {
    if (filter && !filter(i)) continue;
    const d = sqDist(data[i] as Float64Array, query);
    if (best.length < k) {
      best.push({ index: i, d2: d });
      best.sort((a, b) => a.d2 - b.d2);
    } else if (d < (best[best.length - 1] as { d2: number }).d2) {
      best[best.length - 1] = { index: i, d2: d };
      best.sort((a, b) => a.d2 - b.d2);
    }
  }
  return best;
}
