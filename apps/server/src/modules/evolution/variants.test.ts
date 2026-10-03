import { describe, expect, it } from "vitest";
import { strategySpecSchema, type StrategySpec } from "@multbot/shared";
import { Dataset, type DatasetRow } from "../discovery/dataset.js";
import { seededRandom } from "../stats/stats.js";
import type { SampleOutcome } from "../research/outcomes.js";
import { conditionMask, generateVariants, proposeVariant, specMask, specTarget, withTarget } from "./variants.js";
import { Bitset } from "../discovery/recipes.js";

const T0 = Date.UTC(2026, 5, 1);

function gaussian(r: () => number): number {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function outcome(ret300: number, ret900: number): SampleOutcome {
  const h = (ret: number) => ({ net: ret * 0.01, ret, gross: (ret + 0.06) * 0.01, exitSpot: 1, maxRunup: 0, maxDrawdown: 0, tPeakSec: 0 });
  return {
    v: 1,
    positionSol: 0.01,
    params: { delayMs: 1500, failedTxRate: 0.05, priorityFeeSol: 0.0001, mevBps: 50 },
    entry: { ok: true },
    horizons: { "300": h(ret300), "900": h(ret900) },
    tpsl: {},
    path: {},
    pending: [],
  };
}

/** Edge only where f3 ≥ 0.8 and f7 ≤ 0.3; the 15-minute horizon is worse than 5 minutes. */
function rows(n: number, seed: number, planted: boolean): DatasetRow[] {
  const r = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => {
    const features: Record<string, number> = { f3: r(), f7: r(), mkt_volatility_level: Math.floor(r() * 4) };
    const signal = planted && (features.f3 as number) >= 0.8 && (features.f7 as number) <= 0.3;
    const base = signal ? 0.1 : -0.03;
    return {
      id: i + 1,
      ts: T0 + i * 20_000,
      mint: `mint${i}`,
      venue: "pump_curve",
      ageSec: 120,
      trigger: "periodic",
      regimeLabel: null,
      features,
      outcome: outcome(base + 0.2 * gaussian(r), base - 0.04 + 0.2 * gaussian(r)),
    };
  });
}

const parent: StrategySpec = strategySpecSchema.parse({
  family: "recipe",
  universe: { venues: ["pump_curve"] },
  conditions: [
    { kind: "feature", feature: "f3", op: "gte", value: 0.6 },
    { kind: "feature", feature: "f7", op: "lte", value: 0.3 },
  ],
  entry: { cooldownSec: 300 },
  exit: { maxHoldSec: 300 },
  horizonSec: 300,
  params: { target: "h:300" },
});

describe("strategy evolution variants", () => {
  it("maps specs to research targets and back", () => {
    expect(specTarget(parent)).toBe("h:300");
    const tpsl = withTarget(parent, "tpsl:900:0.5:0.2");
    expect(tpsl.exit).toMatchObject({ takeProfitPct: 0.5, stopLossPct: 0.2, maxHoldSec: 900 });
    expect(tpsl.entry.cooldownSec).toBe(900);
    expect(specTarget(tpsl)).toBe("tpsl:900:0.5:0.2");
    expect(specTarget(withTarget(tpsl, "h:60"))).toBe("h:60");
    expect(withTarget(tpsl, "h:60").exit.takeProfitPct).toBeUndefined();
  });

  it("evaluates conditions exactly like live evaluation (missing values never match)", () => {
    const ds = new Dataset(
      [
        { id: 1, ts: T0, mint: "a", venue: "pump_curve", ageSec: 10, trigger: "p", regimeLabel: null, features: { x: 1, mkt_flow_level: 2, ev_spike_age: 5 }, outcome: outcome(0, 0) },
        { id: 2, ts: T0 + 1, mint: "b", venue: "pump_amm", ageSec: 10, trigger: "p", regimeLabel: null, features: { mkt_flow_level: 0, ev_spike_age: 50 }, outcome: outcome(0, 0) },
      ],
      undefined,
      ["h:300"],
    );
    const ids = (b: Bitset) => {
      const out: number[] = [];
      b.forEach((i) => out.push(i));
      return out;
    };
    expect(ids(conditionMask(ds, { kind: "feature", feature: "x", op: "gte", value: 0 }))).toEqual([0]);
    expect(ids(conditionMask(ds, { kind: "event", eventType: "spike", withinSec: 30 }))).toEqual([0]);
    expect(ids(conditionMask(ds, { kind: "regime", dimension: "flow", levels: ["low"] }))).toEqual([1]);
    expect(ids(conditionMask(ds, { kind: "feature", feature: "d:ratio(x,mkt_flow_level)", op: "gt", value: 0.4 }))).toEqual([0]);
    expect(ids(specMask(ds, { ...parent, conditions: [] }))).toEqual([0]);
  });

  it("generates exit, threshold, regime and simplification variants without looking at outcomes", () => {
    const ds = new Dataset(rows(2000, 1, true), undefined, ["h:300", "h:900"]);
    const vs = generateVariants(ds, parent, Bitset.range(ds.n, 0, 1400));
    const kinds = new Set(vs.map((v) => v.kind));
    expect(kinds).toEqual(new Set(["exit", "threshold", "regime_filter", "drop_condition"]));
    expect(vs.find((v) => v.kind === "exit")?.target).toBe("h:900");
    expect(vs.filter((v) => v.kind === "drop_condition")).toHaveLength(2);
    expect(vs.every((v) => v.bump === (v.kind === "exit" || v.kind === "threshold" ? "minor" : "major"))).toBe(true);
  });

  it("finds a better threshold and confirms it on the untouched holdout", () => {
    const ds = new Dataset(rows(30_000, 7, true), undefined, ["h:300", "h:900"]);
    const p = proposeVariant(ds, parent);
    expect(p).not.toBeNull();
    expect(p?.variant.kind).toBe("threshold");
    const f3 = p?.variant.spec.conditions.find((c) => c.kind === "feature" && c.feature === "f3");
    expect(f3 && f3.kind === "feature" ? f3.value : 0).toBeGreaterThan(0.6);
    expect(p?.candidate.holdout.mean).toBeGreaterThan(p?.parent.holdout.mean ?? 0);
    expect(p?.candidate.holdout.mean).toBeGreaterThan(0);
    expect(p?.split.holdoutFrom).toBeGreaterThan(p?.split.trainTo ?? Infinity);
    // exit variant (15 min) was worse and must not be chosen
    expect(p?.variant.target).toBe("h:300");
  });

  it("proposes nothing when there is no edge anywhere", () => {
    const ds = new Dataset(rows(30_000, 9, false), undefined, ["h:300", "h:900"]);
    expect(proposeVariant(ds, parent)).toBeNull();
  });
});
