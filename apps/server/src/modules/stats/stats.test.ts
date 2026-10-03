import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  deflatedSharpeRatio,
  kurtosis,
  maxDrawdown,
  mean,
  median,
  normCdf,
  normInv,
  performance,
  quantile,
  seededRandom,
  skewness,
  spearman,
  std,
  tCdf,
  tTestGreater,
  welchGreater,
} from "./stats.js";
import { fitScaler, kmeans, nearest, transform } from "./ml.js";

describe("descriptive statistics", () => {
  it("basic moments", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(mean(xs)).toBe(3);
    expect(median(xs)).toBe(3);
    expect(std(xs)).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(quantile(xs, 0.25)).toBe(2);
    expect(skewness(xs)).toBeCloseTo(0, 12);
    expect(kurtosis([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBeGreaterThan(3);
  });

  it("max drawdown of cumulative pnl", () => {
    expect(maxDrawdown([1, -2, 3, -4, 1])).toBe(4);
    expect(maxDrawdown([1, 1, 1])).toBe(0);
  });
});

describe("distributions", () => {
  it("normal CDF and inverse", () => {
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normCdf(0)).toBeCloseTo(0.5, 8);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.01)).toBeCloseTo(-2.326348, 5);
    for (const p of [0.001, 0.2, 0.5, 0.8, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
  });

  it("Student-t CDF matches tables", () => {
    expect(tCdf(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(tCdf(1.812, 10)).toBeCloseTo(0.95, 3);
    expect(tCdf(-2.228, 10)).toBeCloseTo(0.025, 3);
    expect(tCdf(1.96, 100000)).toBeCloseTo(0.975, 3);
  });
});

describe("hypothesis tests", () => {
  it("one-sided t-test detects a positive mean", () => {
    const r = seededRandom(1);
    const xs = Array.from({ length: 400 }, () => 0.1 + (r() - 0.5));
    const t = tTestGreater(xs);
    expect(t.pValue).toBeLessThan(0.001);
    const ys = Array.from({ length: 400 }, () => r() - 0.5);
    expect(tTestGreater(ys).pValue).toBeGreaterThan(0.01);
  });

  it("welch test compares two groups", () => {
    const r = seededRandom(2);
    const a = Array.from({ length: 200 }, () => 0.2 + r());
    const b = Array.from({ length: 200 }, () => r());
    expect(welchGreater(a, b).pValue).toBeLessThan(0.001);
    expect(welchGreater(b, a).pValue).toBeGreaterThan(0.99);
  });

  it("Benjamini–Hochberg q-values", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    expect(q[0]).toBeCloseTo(0.02, 12);
    expect(q[1]).toBeCloseTo(0.04, 12);
    expect(q[2]).toBeCloseTo(0.04, 12);
    expect(q[3]).toBeCloseTo(0.02, 12);
  });

  it("multiple testing: pure noise yields (almost) no discoveries", () => {
    const r = seededRandom(3);
    const pvals: number[] = [];
    for (let h = 0; h < 500; h++) pvals.push(tTestGreater(Array.from({ length: 50 }, () => r() - 0.5)).pValue);
    const naive = pvals.filter((p) => p < 0.05).length;
    const bh = benjaminiHochberg(pvals).filter((q) => q < 0.05).length;
    expect(naive).toBeGreaterThan(5); // uncorrected testing "finds" strategies in noise
    expect(bh).toBeLessThanOrEqual(2);
  });

  it("deflated Sharpe penalises many trials", () => {
    const base = { sharpe: 0.15, n: 300, skew: 0, kurtosis: 3, sharpeVariance: 0.005 };
    const few = deflatedSharpeRatio({ ...base, trials: 2 });
    const many = deflatedSharpeRatio({ ...base, trials: 10_000 });
    expect(few).toBeGreaterThan(many);
    expect(many).toBeLessThan(0.5);
  });

  it("spearman", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
  });
});

describe("performance summary", () => {
  it("computes trading statistics", () => {
    const p = performance([0.01, -0.005, 0.02, -0.01, 0.005]);
    expect(p.n).toBe(5);
    expect(p.wins).toBe(3);
    expect(p.winRate).toBeCloseTo(0.6, 12);
    expect(p.profitFactor).toBeCloseTo(0.035 / 0.015, 9);
    expect(p.sum).toBeCloseTo(0.02, 12);
    expect(p.worst).toBe(-0.01);
    expect(p.expectancy).toBeCloseTo(p.mean, 12);
  });
});

describe("ml helpers", () => {
  it("k-means separates obvious clusters and kNN finds neighbours", () => {
    const rows: Record<string, number>[] = [];
    const r = seededRandom(5);
    for (let i = 0; i < 100; i++) rows.push({ a: r(), b: r() });
    for (let i = 0; i < 100; i++) rows.push({ a: 10 + r(), b: 10 + r() });
    const sc = fitScaler(rows, ["a", "b"]);
    const X = rows.map((row) => transform(sc, row));
    const km = kmeans(X, 2, { seed: 1 });
    expect(new Set(Array.from(km.assignment.slice(0, 100))).size).toBe(1);
    expect(km.assignment[0]).not.toBe(km.assignment[150]);
    const nn = nearest(X, transform(sc, { a: 10.5, b: 10.5 }), 5);
    expect(nn.every((x) => x.index >= 100)).toBe(true);
  });
});
