import { describe, expect, it } from "vitest";
import { Dataset, type DatasetRow } from "./dataset.js";
import { DEFAULT_DISCOVERY, DiscoveryEngine } from "./engine.js";
import { Bitset, EvalScratch, evaluateMask, atomMask } from "./recipes.js";
import { seededRandom } from "../stats/stats.js";
import type { SampleOutcome } from "../research/outcomes.js";

const T0 = Date.UTC(2026, 5, 1);

function gaussian(r: () => number): number {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function outcome(ret: number): SampleOutcome {
  return {
    v: 1,
    positionSol: 0.01,
    params: { delayMs: 1500, failedTxRate: 0.05, priorityFeeSol: 0.0001, mevBps: 50 },
    entry: { ok: true },
    horizons: { "300": { net: ret * 0.01, ret, gross: (ret + 0.06) * 0.01, exitSpot: 1, maxRunup: 0, maxDrawdown: 0, tPeakSec: 0 } },
    tpsl: {},
    path: {},
    pending: [],
  };
}

function makeRows(n: number, seed: number, planted: boolean): DatasetRow[] {
  const r = seededRandom(seed);
  const rows: DatasetRow[] = [];
  for (let i = 0; i < n; i++) {
    const features: Record<string, number> = {};
    for (let f = 0; f < 15; f++) features[`f${f}`] = r();
    features.ev_volume_spike_age = r() < 0.2 ? r() * 60 : 3600;
    const signal = planted && (features.f3 as number) >= 0.75 && (features.f7 as number) <= 0.3;
    const ret = (signal ? 0.12 : -0.03) + 0.25 * gaussian(r);
    rows.push({
      id: i + 1,
      ts: T0 + i * 60_000,
      mint: `mint${Math.floor(r() * 5000)}`,
      venue: "pump_curve",
      ageSec: 60,
      trigger: "periodic",
      regimeLabel: r() < 0.5 ? "normal" : "high_volatility",
      features,
      outcome: outcome(ret),
    });
  }
  return rows;
}

const cfg = { ...DEFAULT_DISCOVERY, targets: ["h:300"], minSamples: 100, maxHypotheses: 4000, beamWidth: 20, atomPool: 60, embargoMs: 3_600_000 };

describe("recipe evaluation", () => {
  it("de-duplicates matches of the same token within the cooldown", () => {
    const rows: DatasetRow[] = [0, 1, 2, 10].map((m, i) => ({
      id: i,
      ts: T0 + m * 60_000,
      mint: "same",
      venue: "pump_curve",
      ageSec: 1,
      trigger: "periodic",
      regimeLabel: null,
      features: { x: 1 },
      outcome: outcome(0.1),
    }));
    const ds = new Dataset(rows, ["x"], ["h:300"]);
    const mask = atomMask(ds, { feature: "x", op: "gte", value: 0.5, level: null });
    const ev = evaluateMask(ds, mask, ds.target("h:300"), 300_000, new EvalScratch(ds.mints.length));
    expect(ev.n).toBe(2); // t=0 counted, t=1,2 min skipped, t=10 min counted
  });

  it("bitset operations", () => {
    const a = Bitset.range(100, 10, 20);
    const b = Bitset.range(100, 15, 40);
    expect(a.and(b).count()).toBe(5);
    const seen: number[] = [];
    a.forEach((i) => seen.push(i));
    expect(seen).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const c = new Bitset(64);
    c.set(31);
    c.set(63);
    expect(c.has(31) && c.has(63) && !c.has(30)).toBe(true);
  });
});

describe("DiscoveryEngine", () => {
  it("finds a planted signal and validates it out of sample", () => {
    const ds = new Dataset(makeRows(20_000, 11, true), undefined, ["h:300"]);
    const res = new DiscoveryEngine(ds, cfg).run();
    expect(res.insufficientData).toBe(false);
    expect(res.hypothesesTested).toBeGreaterThan(100);
    const survivors = res.candidates.filter((c) => c.verdict === "survived");
    expect(survivors.length).toBeGreaterThan(0);
    const best = survivors[0]!;
    const features = best.atoms.map((a) => a.feature);
    expect(features).toContain("f3");
    expect(best.holdout!.mean).toBeGreaterThan(0);
    expect(best.overfit.dsr).toBeGreaterThan(0.9);
    expect(best.whyItMightFail.length).toBeGreaterThan(0);
    expect(best.multipleTesting.qValue).toBeLessThanOrEqual(0.05);
  });

  it("does not report strategies in pure noise", () => {
    const ds = new Dataset(makeRows(20_000, 12, false), undefined, ["h:300"]);
    const res = new DiscoveryEngine(ds, cfg).run();
    expect(res.hypothesesTested).toBeGreaterThan(100);
    expect(res.candidates.filter((c) => c.verdict === "survived")).toHaveLength(0);
  });

  it("refuses to run on too little data", () => {
    const ds = new Dataset(makeRows(100, 13, true), undefined, ["h:300"]);
    const res = new DiscoveryEngine(ds, cfg).run();
    expect(res.insufficientData).toBe(true);
    expect(res.candidates).toHaveLength(0);
  });
});
