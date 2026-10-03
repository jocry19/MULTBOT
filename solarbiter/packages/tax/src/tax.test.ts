import { describe, expect, it } from "vitest";
import { SOL_MINT } from "@solarbiter/shared";
import { FifoBook, totalCost } from "./fifo.js";
import { TAX_DISCLAIMER, TaxLedger, toCsv, toJson } from "./ledger.js";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const DAY = 86_400_000;

describe("FIFO", () => {
  it("consumes the oldest lots first and reports unknown cost for uncovered quantity", () => {
    const b = new FifoBook();
    b.acquire("X", 100n, 10, 0, "manual", null);
    b.acquire("X", 100n, 30, DAY, "manual", null);
    const a = b.dispose("X", 150n, 3 * DAY);
    expect(a.map((x) => [x.quantity, x.costEur, x.holdingDays])).toEqual([
      [100n, 10, 3],
      [50n, 15, 2],
    ]);
    expect(totalCost(a)).toBe(25);
    expect(b.balance("X")).toBe(50n);
    const more = b.dispose("X", 80n, 4 * DAY);
    expect(totalCost(more)).toBeNull();
    expect(b.dirty().length).toBe(2);
  });
});

describe("TaxLedger", () => {
  it("documents an atomic arbitrage as swaps + fee with FIFO cost basis and EUR values", () => {
    const t = new TaxLedger();
    t.deposit(0, "dep", "W", 1_000_000_000n, 100, 100); // 1 SOL bought for 100 €
    const rows = t.recordArbitrage({
      ts: 10 * DAY,
      signature: "sig",
      wallet: "W",
      liveTradeId: "live_1",
      solEur: 120,
      solEurTs: 10 * DAY,
      route: [SOL_MINT, JUP, SOL_MINT],
      dexes: ["raydium", "orca"],
      decimals: (m) => (m === SOL_MINT ? 9 : 6),
      inputLamports: 40_000_000n,
      outputLamports: 40_200_000n,
      intermediateAmounts: [5_000_000n],
      feesLamports: 25_000n,
    });
    expect(rows.map((r) => r.kind)).toEqual(["swap", "swap", "fee"]);
    const [buy, sell, fee] = rows;
    // SOL disposed at 4.80 € with a cost basis of 4.00 € (bought at 100 €/SOL)
    expect(buy!.disposalValueEur).toBeCloseTo(4.8, 9);
    expect(buy!.acquisitionValueEur).toBeCloseTo(4.0, 9);
    expect(buy!.realizedPnlEur).toBeCloseTo(0.8, 9);
    expect(buy!.lotDetails!.allocations[0]!.holdingDays).toBe(10);
    // token disposed for 4.824 € with cost 4.80 €
    expect(sell!.assetOut).toBe(JUP);
    expect(sell!.realizedPnlEur).toBeCloseTo(0.024, 9);
    expect(fee!.feeEur).toBeCloseTo(0.003, 9);
    expect(fee!.realizedPnlEur).toBeLessThan(0);
    const csv = toCsv(rows);
    expect(csv.split("\n")[0]).toBe(`# ${TAX_DISCLAIMER}`);
    expect(csv).toContain("0.04,");
    expect(JSON.parse(toJson(rows)).disclaimer).toMatch(/Keine Steuerberatung/);
  });

  it("unknown cost basis stays unknown (never invented)", () => {
    const t = new TaxLedger();
    const rows = t.recordArbitrage({ ts: 1, signature: "s", wallet: "W", liveTradeId: "l", solEur: 120, solEurTs: 1, route: [SOL_MINT, JUP, SOL_MINT], dexes: ["a", "b"], decimals: () => 9, inputLamports: 10n, outputLamports: 11n, intermediateAmounts: [5n], feesLamports: 0n });
    expect(rows[0]!.acquisitionValueEur).toBeNull();
    expect(rows[0]!.realizedPnlEur).toBeNull();
    expect(() => t.recordArbitrage({ ts: 1, signature: "s", wallet: "W", liveTradeId: "l", solEur: 120, solEurTs: 1, route: [JUP, SOL_MINT], dexes: [], decimals: () => 9, inputLamports: 1n, outputLamports: 1n, intermediateAmounts: [], feesLamports: 0n })).toThrow();
  });
});
