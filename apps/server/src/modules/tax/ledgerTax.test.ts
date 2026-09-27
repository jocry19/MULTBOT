import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import type { Database } from "../../db/database.js";
import { Ledger } from "../ledger/ledger.js";
import { TaxLedger, TAX_DISCLAIMER } from "./taxLedger.js";
import type { FxService } from "./fx.js";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe("ledger", () => {
  it("hash-chains entries and detects a broken chain", async () => {
    const ledger = new Ledger(db);
    const a = await ledger.append("TRADE_OPEN", { tradeId: "t1", solValue: 0.01, mint: "m" }, "t1", "sig1");
    const b = await ledger.append("TRADE_CLOSE", { tradeId: "t1", netPnlSol: 0.002 }, "t1", "sig2");
    expect(a.hash).not.toBe(b.hash);
    expect(await ledger.verify()).toEqual({ ok: true, entries: 2, brokenAt: null });
    // tampering is impossible through normal SQL …
    await expect(db.query("UPDATE ledger_entries SET data = '{}'")).rejects.toThrow(/append-only/);
    // … and would be detected if done by disabling triggers
    await db.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_immutable");
    await db.query(`UPDATE ledger_entries SET data = '{"tradeId":"t1","netPnlSol":999}' WHERE id = $1`, [b.id]);
    await db.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_immutable");
    expect((await ledger.verify()).brokenAt).toBe(b.id);
  });
});

describe("tax ledger (FIFO, documentation only)", () => {
  const fx = { solEur: async () => 100 } as unknown as FxService;

  it("documents deposit, buy and sell with FIFO cost basis and gains in EUR", async () => {
    const tax = new TaxLedger(db, fx);
    const t0 = new Date("2026-03-01T10:00:00Z");
    await tax.recordDeposit(t0, 1, "dep1", 80); // 1 SOL declared at 80 EUR
    await tax.recordBuy({ ts: new Date("2026-03-02T10:00:00Z"), mint: "MINT", tokens: 1000, solSpent: 0.0105, feesSol: 0.0005, signature: "b1", tradeId: "T1" });
    await tax.recordSell({ ts: new Date("2026-03-02T10:05:00Z"), mint: "MINT", tokens: 1000, solReceived: 0.02, feesSol: 0.0004, signature: "s1", tradeId: "T1" });
    const disposals = await db.many<{ asset: string; kind: string; proceeds_eur: number; cost_basis_eur: number; gain_eur: number }>("SELECT asset, kind, proceeds_eur, cost_basis_eur, gain_eur FROM tax_disposals ORDER BY id");
    // swap of SOL: proceeds 0.0105*100 = 1.05 EUR, cost 0.0105 * 80 = 0.84 EUR
    expect(disposals[0]!.asset).toBe("SOL");
    expect(disposals[0]!.gain_eur).toBeCloseTo(0.21, 9);
    // token sale: proceeds 2.00 EUR, cost 1.05 EUR
    expect(disposals[1]!.asset).toBe("MINT");
    expect(disposals[1]!.kind).toBe("sale");
    expect(disposals[1]!.gain_eur).toBeCloseTo(0.95, 9);
    const csv = await tax.exportCsv(2026);
    expect(csv).toContain(TAX_DISCLAIMER);
    expect(csv.split("\n").length).toBeGreaterThan(5);
    const xlsx = await tax.exportXlsx(2026);
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(JSON.parse(await tax.exportJson(2026)).rows.length).toBeGreaterThan(3);
  });

  it("marks unknown cost basis instead of inventing one", async () => {
    const tax = new TaxLedger(db, fx);
    await tax.recordDeposit(new Date("2026-04-01T00:00:00Z"), 0.5, "dep2", null);
    await db.query("UPDATE tax_lots SET remaining = 0 WHERE asset = 'SOL' AND cost_eur IS NOT NULL"); // leave only the unknown-cost deposit
    await tax.recordBuy({ ts: new Date("2026-04-02T00:00:00Z"), mint: "MINT2", tokens: 10, solSpent: 0.01, feesSol: 0, signature: "b2", tradeId: "T2" });
    const d = await db.one<{ gain_eur: number | null; cost_basis_eur: number | null }>("SELECT gain_eur, cost_basis_eur FROM tax_disposals WHERE signature = 'b2'");
    expect(d?.cost_basis_eur).toBeNull();
    expect(d?.gain_eur).toBeNull();
  });
});
