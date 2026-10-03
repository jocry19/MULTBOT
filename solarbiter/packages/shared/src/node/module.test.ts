import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { PeriodicTask } from "./module.js";

const log = createLogger({ level: "silent" });

describe("PeriodicTask", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at the configured interval", async () => {
    let runs = 0;
    const t = new PeriodicTask("t", 1_000, async () => void runs++, log);
    t.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toBe(3);
    t.stop();
  });

  it("applies a new interval at runtime, restarting the pending wait", async () => {
    let runs = 0;
    const t = new PeriodicTask("t", 2_000, async () => void runs++, log);
    t.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toBe(1);

    t.setIntervalMs(6_000);
    expect(t.interval).toBe(6_000);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runs).toBe(4);

    t.setIntervalMs(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(5);
    t.stop();
  });

  it("does not schedule after stop", async () => {
    let runs = 0;
    const t = new PeriodicTask("t", 1_000, async () => void runs++, log);
    t.start();
    t.stop();
    t.setIntervalMs(100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(0);
  });
});
