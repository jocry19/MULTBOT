import type { PerformanceStats } from "@multbot/shared";

/**
 * Statistics used for strategy validation. Implemented from first principles (no dependencies) and
 * unit-tested against known values.
 */

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] as number;
  return s / xs.length;
}

export function variance(xs: ArrayLike<number>, sample = true): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (xs[i] as number) - m;
    s += d * d;
  }
  return s / (sample ? n - 1 : n);
}

export function std(xs: ArrayLike<number>, sample = true): number {
  return Math.sqrt(variance(xs, sample));
}

export function sorted(xs: ArrayLike<number>): number[] {
  return Array.from(xs).sort((a, b) => a - b);
}

/** Linear-interpolated quantile of an already sorted array. */
export function quantileSorted(s: number[], q: number): number {
  if (s.length === 0) return 0;
  const idx = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (idx - lo);
}

export function quantile(xs: ArrayLike<number>, q: number): number {
  return quantileSorted(sorted(xs), q);
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

export function skewness(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const sd = std(xs, false);
  if (sd === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += (((xs[i] as number) - m) / sd) ** 3;
  return s / n;
}

/** Non-excess kurtosis (normal = 3). */
export function kurtosis(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs);
  const sd = std(xs, false);
  if (sd === 0) return 3;
  let s = 0;
  for (let i = 0; i < n; i++) s += (((xs[i] as number) - m) / sd) ** 4;
  return s / n;
}

// ---------------------------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse standard normal CDF (Acklam, relative error < 1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) / (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
}

function logGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  if (df <= 0) return 0.5;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

export interface TTestResult {
  n: number;
  mean: number;
  std: number;
  t: number;
  /** One-sided p-value for H1: mean > mu0. */
  pValue: number;
}

/** One-sample one-sided t-test (H1: mean > mu0). */
export function tTestGreater(xs: ArrayLike<number>, mu0 = 0): TTestResult {
  const n = xs.length;
  const m = mean(xs);
  const s = std(xs);
  if (n < 2) return { n, mean: m, std: s, t: 0, pValue: 1 };
  if (s === 0) return { n, mean: m, std: 0, t: m > mu0 ? Infinity : 0, pValue: m > mu0 ? 0 : 1 };
  const t = (m - mu0) / (s / Math.sqrt(n));
  return { n, mean: m, std: s, t, pValue: 1 - tCdf(t, n - 1) };
}

/** Welch two-sample one-sided test (H1: mean(a) > mean(b)). */
export function welchGreater(a: ArrayLike<number>, b: ArrayLike<number>): { t: number; df: number; pValue: number } {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return { t: 0, df: 1, pValue: 1 };
  const va = variance(a) / na;
  const vb = variance(b) / nb;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { t: 0, df: 1, pValue: mean(a) > mean(b) ? 0 : 1 };
  const t = (mean(a) - mean(b)) / se;
  const df = (va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1));
  return { t, df, pValue: 1 - tCdf(t, df) };
}

/**
 * Benjamini–Hochberg: returns q-values (adjusted p-values) in the input order.
 * A hypothesis is a discovery at FDR α if q ≤ α.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const q = new Array<number>(m).fill(1);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const { p, i } = order[k] as { p: number; i: number };
    const val = Math.min(prev, (p * m) / (k + 1));
    q[i] = val;
    prev = val;
  }
  return q;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014): probability that the observed Sharpe ratio
 * is above the maximum Sharpe expected from `trials` independent strategies with zero skill.
 */
export function deflatedSharpeRatio(opts: {
  sharpe: number;
  n: number;
  skew: number;
  kurtosis: number;
  trials: number;
  /** Variance of Sharpe ratios across all tried strategies. */
  sharpeVariance: number;
}): number {
  const { sharpe, n, skew, kurtosis: kurt, trials, sharpeVariance } = opts;
  if (n < 3) return 0;
  if (!Number.isFinite(sharpe)) return sharpe > 0 ? 1 : 0;
  const gamma = 0.5772156649;
  const N = Math.max(2, trials);
  const sr0 = Math.sqrt(Math.max(0, sharpeVariance)) * ((1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E)));
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe));
  return normCdf(((sharpe - sr0) * Math.sqrt(n - 1)) / denom);
}

/** Probabilistic Sharpe Ratio against a benchmark Sharpe of 0. */
export function probabilisticSharpe(sharpe: number, n: number, skew: number, kurt: number): number {
  if (n < 3) return 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe));
  return normCdf((sharpe * Math.sqrt(n - 1)) / denom);
}

/** Spearman rank correlation. */
export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const rank = (arr: ArrayLike<number>) => {
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (arr[a] as number) - (arr[b] as number));
    const r = new Float64Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && arr[idx[j + 1] as number] === arr[idx[i] as number]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k] as number] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x);
  const ry = rank(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (rx[i] as number) - mx;
    const b = (ry[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/** Max drawdown (positive number) of the cumulative sum of `pnl` in order. */
export function maxDrawdown(pnl: ArrayLike<number>): number {
  let peak = 0;
  let cum = 0;
  let mdd = 0;
  for (let i = 0; i < pnl.length; i++) {
    cum += pnl[i] as number;
    if (cum > peak) peak = cum;
    if (peak - cum > mdd) mdd = peak - cum;
  }
  return mdd;
}

/** Summary of net results (in trade order). */
export function performance(results: ArrayLike<number>): PerformanceStats {
  const xs = Array.from(results);
  const n = xs.length;
  if (n === 0) {
    return { n: 0, wins: 0, losses: 0, winRate: 0, mean: 0, median: 0, std: 0, sum: 0, best: 0, worst: 0, p05: 0, p95: 0, profitFactor: 0, expectancy: 0, maxDrawdown: 0, tStat: 0, pValue: 1, tailLoss: 0 };
  }
  const s = sorted(xs);
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const x of xs) {
    if (x > 0) {
      wins++;
      grossWin += x;
    } else if (x < 0) {
      losses++;
      grossLoss -= x;
    }
  }
  const tt = tTestGreater(xs);
  const tailN = Math.max(1, Math.floor(n * 0.05));
  const tail = s.slice(0, tailN);
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  return {
    n,
    wins,
    losses,
    winRate: wins / n,
    mean: tt.mean,
    median: quantileSorted(s, 0.5),
    std: tt.std,
    sum: xs.reduce((a, b) => a + b, 0),
    best: s[n - 1] as number,
    worst: s[0] as number,
    p05: quantileSorted(s, 0.05),
    p95: quantileSorted(s, 0.95),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: (wins / n) * avgWin - (losses / n) * avgLoss,
    maxDrawdown: maxDrawdown(xs),
    tStat: Number.isFinite(tt.t) ? tt.t : 0,
    pValue: tt.pValue,
    tailLoss: mean(tail),
  };
}

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit seed. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
