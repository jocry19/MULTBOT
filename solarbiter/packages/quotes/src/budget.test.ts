import { describe, expect, it } from "vitest";
import { QuoteBudget } from "./budget.js";

describe("QuoteBudget (sliding window)", () => {
  it("admits bursts, reserves capacity for final checks and releases after the window", async () => {
    let t = 0;
    const b = new QuoteBudget(1, () => t); // 60/min → 54 with margin
    expect(b.capacity).toBe(54);
    expect(b.available("ladder")).toBe(27);
    expect(b.available("verify")).toBe(40);
    expect(b.tryTake(27, "ladder")).toBe(true);
    expect(b.tryTake(1, "ladder")).toBe(false);
    expect(b.waitMs(1, "ladder")).toBe(60_001);
    t = 10_000;
    expect(b.tryTake(13, "verify")).toBe(true);
    expect(b.tryTake(1, "verify")).toBe(false);
    expect(b.tryTake(14, "final")).toBe(true);
    expect(b.tryTake(1, "final")).toBe(false);
    // the first 27 stamps (t = 0) age out after 60 s
    expect(b.waitMs(1, "final")).toBe(50_001);
    t = 60_001;
    expect(b.available("final")).toBe(27);
    let slept = 0;
    expect(await b.take(28, "final", 100_000, async (ms) => { slept = ms; t += ms; })).toBe(true);
    expect(slept).toBe(10_000);
    expect(b.waitMs(100, "final")).toBe(Number.POSITIVE_INFINITY);
  });
});
