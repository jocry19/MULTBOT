import type { FeatureCondition } from "@multbot/shared";
import type { Dataset } from "./dataset.js";

/**
 * Recipe evaluation on a Dataset with bitset masks.
 *
 * Statistical honesty: samples of the same token close in time are strongly correlated (overlapping
 * forward windows). Every evaluation therefore de-duplicates matched rows: per token, a row is only
 * counted if no counted row of the same token lies within `cooldownMs` before it — exactly what a
 * strategy with an entry cooldown would do.
 */

export class Bitset {
  readonly words: Uint32Array;
  constructor(readonly size: number, words?: Uint32Array) {
    this.words = words ?? new Uint32Array(Math.ceil(size / 32));
  }
  set(i: number): void {
    (this.words as Uint32Array)[i >>> 5] = ((this.words[i >>> 5] as number) | (1 << (i & 31))) >>> 0;
  }
  has(i: number): boolean {
    return (((this.words[i >>> 5] as number) >>> (i & 31)) & 1) === 1;
  }
  and(other: Bitset): Bitset {
    const out = new Uint32Array(this.words.length);
    for (let w = 0; w < out.length; w++) out[w] = ((this.words[w] as number) & (other.words[w] as number)) >>> 0;
    return new Bitset(this.size, out);
  }
  andInPlace(other: Bitset): this {
    for (let w = 0; w < this.words.length; w++) this.words[w] = ((this.words[w] as number) & (other.words[w] as number)) >>> 0;
    return this;
  }
  clone(): Bitset {
    return new Bitset(this.size, Uint32Array.from(this.words));
  }
  count(): number {
    let c = 0;
    for (const w of this.words) {
      let v = w - ((w >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      c += (((v + (v >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24;
    }
    return c;
  }
  /** Iterate set bits in ascending order. */
  forEach(fn: (i: number) => void): void {
    for (let w = 0; w < this.words.length; w++) {
      let word = this.words[w] as number;
      while (word !== 0) {
        const t = word & -word;
        const bit = 31 - Math.clz32(t);
        fn(w * 32 + bit);
        word = (word ^ t) >>> 0;
      }
    }
  }
  static range(size: number, from: number, to: number): Bitset {
    const b = new Bitset(size);
    for (let i = Math.max(0, from); i < Math.min(size, to); i++) b.set(i);
    return b;
  }
}

export interface Atom {
  feature: string;
  op: "gte" | "lte";
  value: number;
  /** Quantile level the threshold was taken from (for walk-forward re-fitting); null = fixed. */
  level: number | null;
}

export function atomKey(a: Atom): string {
  return `${a.feature}|${a.op}|${a.value.toPrecision(6)}`;
}

export function atomToCondition(a: Atom): FeatureCondition {
  return { kind: "feature", feature: a.feature, op: a.op, value: Number(a.value.toPrecision(6)) };
}

export function atomMask(ds: Dataset, a: Atom, value = a.value): Bitset {
  const col = ds.feature(a.feature);
  const b = new Bitset(ds.n);
  if (!col) return b;
  for (let i = 0; i < ds.n; i++) {
    const v = col[i] as number;
    if (v !== v) continue; // NaN
    if (a.op === "gte" ? v >= value : v <= value) b.set(i);
  }
  return b;
}

export interface Evaluation {
  n: number;
  mean: number;
  std: number;
  t: number;
  winRate: number;
  indices: number[];
}

/** Scratch space reused across evaluations (per-mint last counted time). */
export class EvalScratch {
  readonly lastTs: Float64Array;
  private readonly touched: number[] = [];
  constructor(mints: number) {
    this.lastTs = new Float64Array(mints).fill(-Infinity);
  }
  touch(m: number): void {
    this.touched.push(m);
  }
  reset(): void {
    for (const m of this.touched) this.lastTs[m] = -Infinity;
    this.touched.length = 0;
  }
}

/** Evaluate target values over mask rows with per-token cooldown de-duplication. */
export function evaluateMask(
  ds: Dataset,
  mask: Bitset,
  target: Float32Array,
  cooldownMs: number,
  scratch: EvalScratch,
  keepIndices = false,
): Evaluation {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  let wins = 0;
  const indices: number[] = [];
  mask.forEach((i) => {
    const y = target[i] as number;
    if (y !== y) return;
    const m = ds.mintIdx[i] as number;
    const t = ds.ts[i] as number;
    if (t - (scratch.lastTs[m] as number) < cooldownMs) return;
    if (scratch.lastTs[m] === -Infinity) scratch.touch(m);
    scratch.lastTs[m] = t;
    n++;
    sum += y;
    sum2 += y * y;
    if (y > 0) wins++;
    if (keepIndices) indices.push(i);
  });
  scratch.reset();
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 1 ? Math.max(0, (sum2 - n * mean * mean) / (n - 1)) : 0;
  const std = Math.sqrt(variance);
  // zero variance (deterministic outcomes): the sign of the mean decides
  const t = n > 1 ? (std > 0 ? mean / (std / Math.sqrt(n)) : mean > 0 ? Infinity : mean < 0 ? -Infinity : 0) : 0;
  return { n, mean, std, t, winRate: n > 0 ? wins / n : 0, indices };
}

/** Quantile of a feature column over the rows in `mask` (ignoring NaN). */
export function columnQuantile(ds: Dataset, feature: string, mask: Bitset, q: number): number | null {
  const col = ds.feature(feature);
  if (!col) return null;
  const vals: number[] = [];
  mask.forEach((i) => {
    const v = col[i] as number;
    if (v === v) vals.push(v);
  });
  if (vals.length < 20) return null;
  vals.sort((a, b) => a - b);
  const idx = q * (vals.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return (vals[lo] as number) + ((vals[hi] as number) - (vals[lo] as number)) * (idx - lo);
}
