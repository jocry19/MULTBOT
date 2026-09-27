import { mean, quantile, std, type ExecutionFeatures } from "@solarbiter/shared";

/** One executed (paper / shadow / live) trade with prediction and outcome — the unit of learning. */
export interface LearningSample {
  ts: number;
  mode: "paper" | "shadow" | "live";
  routeKey: string;
  features: ExecutionFeatures;
  /** Execution probability predicted at decision time. */
  predictedP: number;
  /** Outcome known: true = landed with the guards satisfied. */
  success: boolean;
  inputLamports: number;
  predictedNetLamports: number;
  realizedNetLamports: number;
  /** Predicted adverse move (bps) and the realised one (detected output − realised output, bps). */
  predictedSlippageBps: number;
  realizedSlippageBps: number | null;
  latencyMs: number;
  predictedFeesLamports: number;
  actualFeesLamports: number;
  solEur: number;
  /** Predicted usable edge (bps) and threshold-relevant metrics at decision time (for replays). */
  usableEdgeBps: number;
  usableEdgeEur: number;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Solve A·x = b (Gaussian elimination with partial pivoting); null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[p] as number[])[c] as number)) p = r;
    if (Math.abs((M[p] as number[])[c] as number) < 1e-12) return null;
    [M[c], M[p]] = [M[p] as number[], M[c] as number[]];
    const pivot = M[c] as number[];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = M[r] as number[];
      const f = (row[c] as number) / (pivot[c] as number);
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = (row[k] as number) - f * (pivot[k] as number);
    }
  }
  return M.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** Feature vector of the execution model (all bounded, roughly unit scale). */
export function encode(f: ExecutionFeatures): number[] {
  return [
    1,
    Math.min(3, f.quoteAgeMs / 1_000),
    Math.min(5, f.latencyMs / 1_000),
    Math.min(3, f.poolStateAgeMs / 5_000),
    Math.tanh(f.grossBps / 50),
    Math.tanh(f.screenSpreadBps / 50),
    Math.min(2, f.sizeEur / 5),
    f.hops - 2,
    Math.min(3, f.volatilityBps / 100),
    f.strategyType === "triangular" ? 1 : 0,
  ];
}

/**
 * Logistic regression for P(success | features), fitted by L2-regularised gradient descent on the
 * training window. Until enough samples exist, a conservative Beta prior on the overall success
 * rate is blended in (weight shrinks with the sample count).
 */
export class ExecutionModel {
  weights: number[] = [];
  n = 0;
  successes = 0;
  constructor(
    private readonly priorP = 0.5,
    private readonly priorStrength = 20,
  ) {}

  /** Ridge-regularised logistic regression fitted by Newton / IRLS (converges in a few steps). */
  fit(samples: LearningSample[], iterations = 25, l2 = 1): void {
    this.n = samples.length;
    this.successes = samples.filter((s) => s.success).length;
    if (samples.length < 20 || this.successes === 0 || this.successes === samples.length) {
      this.weights = [];
      return;
    }
    const X = samples.map((s) => encode(s.features));
    const y = samples.map((s) => (s.success ? 1 : 0));
    const d = (X[0] as number[]).length;
    let w = new Array<number>(d).fill(0);
    for (let it = 0; it < iterations; it++) {
      const g = new Array<number>(d).fill(0);
      const H: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
      for (let i = 0; i < X.length; i++) {
        const x = X[i] as number[];
        const p = sigmoid(x.reduce((a, v, j) => a + v * (w[j] as number), 0));
        const r = p * (1 - p);
        const err = p - (y[i] as number);
        for (let j = 0; j < d; j++) {
          g[j] = (g[j] as number) + err * (x[j] as number);
          const hj = H[j] as number[];
          for (let k = 0; k < d; k++) hj[k] = (hj[k] as number) + r * (x[j] as number) * (x[k] as number);
        }
      }
      for (let j = 1; j < d; j++) {
        g[j] = (g[j] as number) + l2 * (w[j] as number);
        (H[j] as number[])[j] = ((H[j] as number[])[j] as number) + l2;
      }
      (H[0] as number[])[0] = ((H[0] as number[])[0] as number) + 1e-6;
      const step = solve(H, g);
      if (!step) break;
      w = w.map((v, j) => v - (step[j] as number));
      if (Math.max(...step.map(Math.abs)) < 1e-6) break;
    }
    this.weights = w.every(Number.isFinite) ? w : [];
  }

  /** Beta-smoothed base rate. */
  baseRate(): number {
    return (this.successes + this.priorP * this.priorStrength) / (this.n + this.priorStrength);
  }

  predict(f: ExecutionFeatures): number {
    const base = this.baseRate();
    if (this.weights.length === 0) return base;
    const x = encode(f);
    const p = sigmoid(x.reduce((a, v, j) => a + v * (this.weights[j] ?? 0), 0));
    const w = this.n / (this.n + this.priorStrength);
    return w * p + (1 - w) * base;
  }
}

/**
 * Spread decay / slippage: the realised adverse move between decision and landing, per venue
 * sequence, with the uncertainty that feeds the safety buffer.
 */
export class SlippageModel {
  private byRoute = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly priorBps = 5) {}

  fit(samples: LearningSample[]): void {
    this.byRoute = new Map();
    this.all = [];
    for (const s of samples) {
      if (s.realizedSlippageBps === null) continue;
      const v = s.realizedSlippageBps;
      this.all.push(v);
      const k = s.features.dexes;
      const list = this.byRoute.get(k) ?? [];
      list.push(v);
      this.byRoute.set(k, list);
    }
  }

  /** Expected adverse move (bps, ≥ 0). Shrinks the route mean towards the global mean. */
  expectedBps(f: ExecutionFeatures): number {
    if (this.all.length < 10) return this.priorBps;
    const g = mean(this.all);
    const r = this.byRoute.get(f.dexes) ?? [];
    const k = 20;
    const est = r.length ? (mean(r) * r.length + g * k) / (r.length + k) : g;
    return Math.max(0, est);
  }

  stdBps(): number {
    return this.all.length < 10 ? this.priorBps : std(this.all);
  }

  /** Mean adverse move over all routes (prior until 10 samples). */
  globalBps(): number {
    return this.all.length < 10 ? this.priorBps : Math.max(0, mean(this.all));
  }

  samples(): number {
    return this.all.length;
  }
}

/** Decision → landing latency (p75 of measurements; configured default until enough samples). */
export class LatencyModel {
  private xs: number[] = [];
  constructor(private defaultMs: number) {}

  setDefault(ms: number): void {
    this.defaultMs = ms;
  }

  fit(samples: LearningSample[]): void {
    this.xs = samples.map((s) => s.latencyMs).filter((x) => x > 0);
  }

  estimateMs(minSamples = 30): number {
    return this.xs.length < minSamples ? this.defaultMs : quantile(this.xs, 0.75);
  }

  samples(): number {
    return this.xs.length;
  }
}

/** Per-route success rate with a Beta prior (feeds the safety buffer). */
export class ReliabilityModel {
  private m = new Map<string, { s: number; n: number }>();

  fit(samples: LearningSample[]): void {
    this.m = new Map();
    for (const x of samples) {
      const r = this.m.get(x.routeKey) ?? { s: 0, n: 0 };
      r.n++;
      if (x.success) r.s++;
      this.m.set(x.routeKey, r);
    }
  }

  reliability(routeKey: string): number {
    const r = this.m.get(routeKey) ?? { s: 0, n: 0 };
    return (r.s + 4) / (r.n + 5); // prior ≈ 0.8 with weight 5
  }
}
