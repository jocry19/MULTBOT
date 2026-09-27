import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, seededRandom, type ExecutionFeatures } from "@solarbiter/shared";
import { LearningEngine } from "./engine.js";
import { evaluateLiveGate } from "./gate.js";
import { ExecutionModel, SlippageModel, type LearningSample } from "./models.js";
import { optimizeThresholds, replay, shouldRollback, thresholdsOf } from "./optimizer.js";
import { chronoSplit, validate, walkForward } from "./validation.js";

const feat = (o: Partial<ExecutionFeatures> = {}): ExecutionFeatures => ({
  strategyType: "direct",
  hops: 2,
  dexes: "raydium>orca",
  sizeEur: 2,
  screenSpreadBps: 20,
  grossBps: 25,
  quoteAgeMs: 300,
  latencyMs: 900,
  poolStateAgeMs: 1_000,
  volatilityBps: 10,
  hourUtc: 12,
  ...o,
});

/**
 * Synthetic world: success is likelier with fresh quotes; realised net is edge minus noise; slippage
 * around 3 bps. Edge quality is encoded in usableEdgeBps so replays can filter.
 */
function world(n: number, seed = 1, edgeShift = 0): LearningSample[] {
  const rnd = seededRandom(seed);
  const out: LearningSample[] = [];
  for (let i = 0; i < n; i++) {
    const quoteAgeMs = rnd() * 1_500;
    const edgeBps = 5 + rnd() * 30 + edgeShift;
    const pTrue = 0.95 - quoteAgeMs / 3_000;
    const success = rnd() < pTrue;
    const input = 16_000_000; // ~2 €
    const slip = 3 + (rnd() - 0.5) * 4;
    const realized = success ? Math.round((input * (edgeBps - slip - 8)) / 10_000) : 0;
    out.push({
      ts: 1_000 + i * 1_000,
      mode: "paper",
      routeKey: i % 2 ? "direct:A" : "direct:B",
      features: feat({ quoteAgeMs, grossBps: edgeBps + 10 }),
      predictedP: 0.8,
      success,
      inputLamports: input,
      predictedNetLamports: Math.round((input * edgeBps) / 10_000),
      realizedNetLamports: realized,
      predictedSlippageBps: 3,
      realizedSlippageBps: success ? slip : null,
      latencyMs: 700 + rnd() * 400,
      predictedFeesLamports: 25_000,
      actualFeesLamports: success ? 25_000 : 0,
      solEur: 120,
      usableEdgeBps: edgeBps,
      usableEdgeEur: (input * edgeBps * 120) / 1e4 / 1e9,
    });
  }
  return out;
}

describe("models", () => {
  it("execution model learns that stale quotes fail more often; prior dominates with little data", () => {
    const m = new ExecutionModel();
    expect(m.predict(feat())).toBeCloseTo(0.5, 6);
    m.fit(world(2_000));
    expect(m.predict(feat({ quoteAgeMs: 100 }))).toBeGreaterThan(m.predict(feat({ quoteAgeMs: 1_400 })) + 0.2);
  });

  it("slippage model: prior until trained, then the observed mean and spread", () => {
    const s = new SlippageModel(5);
    expect(s.expectedBps(feat())).toBe(5);
    s.fit(world(500));
    expect(s.expectedBps(feat())).toBeGreaterThan(2);
    expect(s.expectedBps(feat())).toBeLessThan(4);
    expect(s.stdBps()).toBeGreaterThan(0.5);
  });
});

describe("validation", () => {
  it("chronological 60/20/20 split and expanding walk-forward folds never look ahead", () => {
    const xs = world(100);
    const { train, validation, oos } = chronoSplit([...xs].reverse(), [0.6, 0.2, 0.2]);
    expect([train.length, validation.length, oos.length]).toEqual([60, 20, 20]);
    expect(Math.max(...train.map((x) => x.ts))).toBeLessThan(Math.min(...validation.map((x) => x.ts)));
    const folds = walkForward(xs, 4);
    expect(folds).toHaveLength(4);
    for (const f of folds) expect(Math.max(...f.train.map((x) => x.ts))).toBeLessThan(Math.min(...f.test.map((x) => x.ts)));
  });

  it("a profitable, stable world passes the gate; a losing one does not", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { learning: { minPaperOpportunities: 100, minSimulatedExecutions: 500, minLatencySamples: 50, minExecutionAccuracy: 0.7, maxFailureRate: 0.5, maxPaperDrawdownEur: 5 } });
    const good = world(1_500, 3, 10);
    const rep = validate(good, [0.6, 0.2, 0.2], 4);
    expect(rep.oos.expectancyEur).toBeGreaterThan(0);
    const g = evaluateLiveGate({ paperOpportunities: 5_000, simulatedExecutions: good.length, latencySamples: good.length }, rep, s);
    expect(g.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.value} (${c.required})`)).toEqual([]);
    expect(g.ready).toBe(true);

    const bad = world(1_500, 4, -20);
    const g2 = evaluateLiveGate({ paperOpportunities: 5_000, simulatedExecutions: bad.length, latencySamples: bad.length }, validate(bad, [0.6, 0.2, 0.2], 4), s);
    expect(g2.ready).toBe(false);
    expect(g2.checks.find((c) => c.name === "Out-of-sample expectancy")?.ok).toBe(false);
  });

  it("the gate needs data first (defaults: 5000 opportunities / 500 executions)", () => {
    const g = evaluateLiveGate({ paperOpportunities: 10, simulatedExecutions: 3, latencySamples: 3 }, null, DEFAULT_SETTINGS);
    expect(g.ready).toBe(false);
  });
});

describe("optimizer", () => {
  it("replays only stricter thresholds and proposes one that removes losing low-edge trades", () => {
    const xs = world(3_000, 7, -4); // low-edge trades lose after costs
    const base = thresholdsOf({ ...DEFAULT_SETTINGS.strategy, minNetProfitEur: 0.00001, minNetProfitPercent: 0.001 });
    expect(replay(xs, base, base).length).toBe(xs.length);
    const r = optimizeThresholds(xs, { ...DEFAULT_SETTINGS.strategy, minNetProfitEur: 0.00001, minNetProfitPercent: 0.001, minExecutionProbability: 0.5 }, [0.6, 0.2, 0.2]);
    expect(r.proposal).not.toBeNull();
    expect(r.candidate!.validation.netEur).toBeGreaterThan(r.current.validation.netEur);
    expect(r.proposal!.minNetProfitEur).toBeGreaterThanOrEqual(base.minNetProfitEur);
    expect(r.proposal!.safetyBufferBps).toBeGreaterThanOrEqual(base.safetyBufferBps);
  });

  it("rolls back a version that performs worse than its parent", () => {
    const parent = Array.from({ length: 40 }, (_, i) => 0.01 + (i % 5) * 0.001);
    expect(shouldRollback(Array(10).fill(-0.01), parent).rollback).toBe(false); // too early
    expect(shouldRollback(Array.from({ length: 40 }, (_, i) => -0.002 + (i % 3) * 0.0005), parent).rollback).toBe(true);
    expect(shouldRollback(parent.map((x) => x + 0.001), parent).rollback).toBe(false);
  });
});

describe("LearningEngine", () => {
  it("learns after every trade and reports score, status and gate", () => {
    let t = 0;
    const e = new LearningEngine(() => DEFAULT_SETTINGS, () => (t += 1_000));
    expect(e.latencyMs()).toBe(DEFAULT_SETTINGS.paper.defaultLatencyMs);
    const snap0 = e.snapshot();
    expect(snap0.status).toBe("COLLECTING_DATA");
    expect(snap0.gate.ready).toBe(false);
    for (const s of world(400)) e.ingest(s);
    e.countOpportunity(1_000);
    const snap = e.snapshot();
    expect(snap.samples).toBe(400);
    expect(snap.executionModelTrained).toBe(true);
    expect(snap.latencyMs).toBeGreaterThan(700);
    expect(snap.score).toBeGreaterThan(0);
    expect(snap.counts.paperOpportunities).toBe(1_000);
    expect(e.routeReliability("direct:A")).toBeGreaterThan(0.3);
  });
});
