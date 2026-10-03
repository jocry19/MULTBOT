import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, settingsSchema } from "./settings.js";
import { strategySpecSchema, describeCondition } from "./strategy.js";

describe("settings", () => {
  it("defaults are valid and match the spec (0.01 SOL, max 10 positions)", () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.trading.positionSizeSol).toBe(0.01);
    expect(DEFAULT_SETTINGS.trading.maxOpenPositions).toBe(10);
  });

  it("merges partial updates", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { trading: { positionSizeSol: 0.02 }, risk: { emergencyStop: true } });
    expect(s.trading.positionSizeSol).toBe(0.02);
    expect(s.trading.maxOpenPositions).toBe(10);
    expect(s.risk.emergencyStop).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { trading: { maxOpenPositions: 0 } })).toThrow();
    expect(() => mergeSettings(DEFAULT_SETTINGS, { risk: { tradingHours: { startUtc: "25:00" } } })).toThrow();
  });
});

describe("strategy spec", () => {
  it("parses and describes conditions", () => {
    const spec = strategySpecSchema.parse({
      family: "recipe",
      universe: { venues: ["pump_curve"] },
      conditions: [
        { kind: "feature", feature: "buy_ratio_60s", op: "gte", value: 0.7 },
        { kind: "event", eventType: "volume_spike", withinSec: 30 },
        { kind: "regime", dimension: "activity", levels: ["high"] },
      ],
      entry: { cooldownSec: 600 },
      exit: { maxHoldSec: 600, takeProfitPct: 0.3, stopLossPct: 0.2 },
      horizonSec: 300,
    });
    expect(spec.exit.invalidation).toEqual([]);
    expect(spec.conditions.map(describeCondition)).toEqual([
      "buy_ratio_60s ≥ 0.7",
      "event volume_spike within 30s",
      "regime.activity ∈ {high}",
    ]);
  });
});
