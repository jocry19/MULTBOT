import ExcelJS from "exceljs";
import type { Database, Queryable } from "../../db/database.js";
import type { FxService } from "./fx.js";

/**
 * Documentation of tax-relevant transactions for users in Germany.
 *
 * NO TAX ADVICE. This module documents acquisitions and disposals with timestamps, quantities,
 * EUR values (market rate at the time, if available), fees, FIFO cost basis, holding periods and
 * transaction IDs, so that a tax advisor / tax software can evaluate them.
 *
 * Model (FIFO per asset):
 *   deposit of SOL           → SOL lot (cost basis only if the user declares it, else unknown)
 *   buy token with SOL       → disposal of SOL (swap) + acquisition of the token (cost = EUR value
 *                              of the SOL given incl. fees)
 *   sell token for SOL       → disposal of the token (proceeds = EUR value of SOL received, net of
 *                              fees) + acquisition of SOL
 *   withdrawal of SOL        → transfer out (lots consumed, no gain computed)
 */

export const TAX_DISCLAIMER =
  "Keine Steuerberatung. Diese Aufstellung dokumentiert Transaktionen des Bot-Wallets (FIFO, EUR-Marktkurse zum Transaktionszeitpunkt soweit verfügbar). Bitte durch Steuerberater/Steuersoftware prüfen lassen.";

type Lot = {
  id: number;
  acquired_at: Date;
  remaining: string;
  quantity: string;
  cost_eur: number | null;
};

export interface Allocation {
  lotId: number;
  qty: number;
  costEur: number | null;
  acquiredAt: string;
  holdingDays: number;
}

export class TaxLedger {
  constructor(
    private readonly db: Database,
    private readonly fx: FxService,
  ) {}

  private async addLot(c: Queryable, asset: string, ts: Date, qty: number, costEur: number | null, costSol: number | null, source: string, signature: string | null, tradeId: string | null, notes?: string): Promise<void> {
    if (!(qty > 0)) return;
    await c.query(
      `INSERT INTO tax_lots (asset, acquired_at, quantity, remaining, cost_eur, cost_sol, source, signature, live_trade_id, notes)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)`,
      [asset, ts, qty.toFixed(12), costEur, costSol, source, signature, tradeId, notes ?? null],
    );
  }

  /** Consume lots FIFO. Missing quantity (no lots) is recorded as an allocation with unknown cost. */
  private async consume(c: Queryable, asset: string, ts: Date, qty: number): Promise<Allocation[]> {
    const lots = await c.query<Lot>(
      "SELECT id, acquired_at, remaining, quantity, cost_eur FROM tax_lots WHERE asset = $1 AND remaining > 0 ORDER BY acquired_at, id FOR UPDATE",
      [asset],
    );
    let left = qty;
    const out: Allocation[] = [];
    for (const lot of lots.rows) {
      if (left <= 1e-12) break;
      const rem = Number(lot.remaining);
      const take = Math.min(rem, left);
      const share = Number(lot.quantity) > 0 ? take / Number(lot.quantity) : 0;
      out.push({
        lotId: lot.id,
        qty: take,
        costEur: lot.cost_eur === null ? null : lot.cost_eur * share,
        acquiredAt: lot.acquired_at.toISOString(),
        holdingDays: Math.floor((ts.getTime() - lot.acquired_at.getTime()) / 86_400_000),
      });
      await c.query("UPDATE tax_lots SET remaining = $2 WHERE id = $1", [lot.id, Math.max(0, rem - take).toFixed(12)]);
      left -= take;
    }
    if (left > 1e-9) out.push({ lotId: 0, qty: left, costEur: null, acquiredAt: "", holdingDays: 0 });
    return out;
  }

  private async dispose(c: Queryable, asset: string, ts: Date, qty: number, proceedsEur: number | null, proceedsSol: number | null, feesEur: number, kind: string, signature: string | null, tradeId: string | null): Promise<void> {
    const allocations = await this.consume(c, asset, ts, qty);
    const unknownCost = allocations.some((a) => a.costEur === null);
    const cost = unknownCost ? null : allocations.reduce((s, a) => s + (a.costEur ?? 0), 0);
    const gain = proceedsEur !== null && cost !== null && kind !== "transfer" ? proceedsEur - cost : null;
    await c.query(
      `INSERT INTO tax_disposals (asset, disposed_at, quantity, proceeds_eur, proceeds_sol, cost_basis_eur, fees_eur, gain_eur,
         holding_days_min, holding_days_max, allocations, signature, live_trade_id, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        asset,
        ts,
        qty.toFixed(12),
        proceedsEur,
        proceedsSol,
        cost,
        feesEur,
        gain,
        allocations.length > 0 ? Math.min(...allocations.map((a) => a.holdingDays)) : null,
        allocations.length > 0 ? Math.max(...allocations.map((a) => a.holdingDays)) : null,
        JSON.stringify(allocations),
        signature,
        tradeId,
        kind,
      ],
    );
  }

  async recordDeposit(ts: Date, sol: number, signature: string, declaredCostEur: number | null = null): Promise<void> {
    await this.db.tx((c) => this.addLot(c, "SOL", ts, sol, declaredCostEur, sol, "deposit", signature, null, declaredCostEur === null ? "cost basis unknown (external transfer)" : "declared by user"));
  }

  async recordWithdrawal(ts: Date, sol: number, signature: string): Promise<void> {
    await this.db.tx((c) => this.dispose(c, "SOL", ts, sol, null, sol, 0, "transfer", signature, null));
  }

  /** Buy `tokens` of `mint` for `solSpent` (swap + all fees). */
  async recordBuy(p: { ts: Date; mint: string; tokens: number; solSpent: number; feesSol: number; signature: string | null; tradeId: string }): Promise<void> {
    const rate = await this.fx.solEur(p.ts.getTime());
    const eur = rate !== null ? p.solSpent * rate : null;
    await this.db.tx(async (c) => {
      await this.dispose(c, "SOL", p.ts, p.solSpent, eur, p.solSpent, rate !== null ? p.feesSol * rate : 0, "swap", p.signature, p.tradeId);
      await this.addLot(c, p.mint, p.ts, p.tokens, eur, p.solSpent, "trade", p.signature, p.tradeId);
    });
  }

  /** Sell `tokens` of `mint`, receiving `solReceived` net of fees. */
  async recordSell(p: { ts: Date; mint: string; tokens: number; solReceived: number; feesSol: number; signature: string | null; tradeId: string }): Promise<void> {
    const rate = await this.fx.solEur(p.ts.getTime());
    const eur = rate !== null ? p.solReceived * rate : null;
    await this.db.tx(async (c) => {
      await this.dispose(c, p.mint, p.ts, p.tokens, eur, p.solReceived, rate !== null ? p.feesSol * rate : 0, "sale", p.signature, p.tradeId);
      await this.addLot(c, "SOL", p.ts, p.solReceived, eur, p.solReceived, "trade", p.signature, p.tradeId);
    });
  }

  async rows(year?: number): Promise<Record<string, unknown>[]> {
    const from = year ? new Date(Date.UTC(year, 0, 1)) : new Date(0);
    const to = year ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(8.64e15);
    const disposals = await this.db.many<Record<string, unknown>>(
      `SELECT d.disposed_at AS ts, d.kind, d.asset, d.quantity, d.proceeds_eur, d.proceeds_sol, d.cost_basis_eur, d.fees_eur, d.gain_eur,
              d.holding_days_min, d.holding_days_max, d.signature, d.live_trade_id, d.allocations
         FROM tax_disposals d WHERE d.disposed_at >= $1 AND d.disposed_at < $2 ORDER BY d.disposed_at, d.id`,
      [from, to],
    );
    const acquisitions = await this.db.many<Record<string, unknown>>(
      `SELECT acquired_at AS ts, 'acquisition' AS kind, asset, quantity, cost_eur, cost_sol, source, signature, live_trade_id, notes
         FROM tax_lots WHERE acquired_at >= $1 AND acquired_at < $2 ORDER BY acquired_at, id`,
      [from, to],
    );
    return [...acquisitions, ...disposals].sort((a, b) => (a.ts as Date).getTime() - (b.ts as Date).getTime());
  }

  async exportCsv(year?: number): Promise<string> {
    const rows = await this.rows(year);
    const header = ["Zeitpunkt (UTC)", "Typ", "Asset", "Menge", "SOL-Wert", "Erlös EUR", "Anschaffungskosten EUR", "Gebühren EUR", "Gewinn/Verlust EUR", "Haltedauer Tage (min-max)", "Transaktions-ID", "Trade-ID", "Hinweis"];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [`# ${TAX_DISCLAIMER}`, header.join(";")];
    for (const r of rows) {
      lines.push(
        [
          r.ts,
          r.kind,
          r.asset,
          r.quantity,
          r.proceeds_sol ?? r.cost_sol ?? "",
          r.proceeds_eur ?? "",
          r.cost_basis_eur ?? r.cost_eur ?? "",
          r.fees_eur ?? "",
          r.gain_eur ?? "",
          r.holding_days_min !== undefined && r.holding_days_min !== null ? `${r.holding_days_min}-${r.holding_days_max}` : "",
          r.signature ?? "",
          r.live_trade_id ?? "",
          r.notes ?? "",
        ]
          .map(esc)
          .join(";"),
      );
    }
    return lines.join("\n");
  }

  async exportJson(year?: number): Promise<string> {
    return JSON.stringify({ disclaimer: TAX_DISCLAIMER, year: year ?? null, rows: await this.rows(year) }, null, 2);
  }

  async exportXlsx(year?: number): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "MULTBOT";
    const ws = wb.addWorksheet("Transaktionen");
    ws.addRow([TAX_DISCLAIMER]);
    ws.addRow([]);
    ws.addRow(["Zeitpunkt (UTC)", "Typ", "Asset", "Menge", "SOL-Wert", "Erlös EUR", "Anschaffungskosten EUR", "Gebühren EUR", "Gewinn/Verlust EUR", "Haltedauer min", "Haltedauer max", "Transaktions-ID", "Trade-ID"]).font = { bold: true };
    for (const r of await this.rows(year)) {
      ws.addRow([
        r.ts,
        r.kind,
        r.asset,
        Number(r.quantity),
        (r.proceeds_sol ?? r.cost_sol ?? null) as number | null,
        (r.proceeds_eur ?? null) as number | null,
        (r.cost_basis_eur ?? r.cost_eur ?? null) as number | null,
        (r.fees_eur ?? null) as number | null,
        (r.gain_eur ?? null) as number | null,
        (r.holding_days_min ?? null) as number | null,
        (r.holding_days_max ?? null) as number | null,
        (r.signature ?? "") as string,
        (r.live_trade_id ?? "") as string,
      ]);
    }
    ws.columns.forEach((c) => {
      c.width = 18;
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
