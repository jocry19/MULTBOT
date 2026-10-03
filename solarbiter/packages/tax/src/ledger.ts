import { LAMPORTS_PER_SOL, SOL_MINT } from "@solarbiter/shared";
import { FifoBook, totalCost, type Allocation } from "./fifo.js";

export const TAX_DISCLAIMER =
  "Keine Steuerberatung. Diese Aufstellung dokumentiert die Transaktionen des Bot-Wallets (FIFO je Asset, EUR-Werte zum SOL/EUR-Kurs des Transaktionszeitpunkts). Bitte durch Steuerberater bzw. Steuersoftware prüfen lassen.";

/** One row of tax_transactions. */
export interface TaxRow {
  ts: number;
  signature: string;
  walletAddress: string;
  kind: "swap" | "fee" | "deposit" | "withdrawal";
  assetIn: string | null;
  amountIn: bigint | null;
  assetInDecimals: number | null;
  assetOut: string | null;
  amountOut: bigint | null;
  assetOutDecimals: number | null;
  eurValue: number | null;
  eurPrice: number;
  eurPriceTs: number;
  fees: bigint | null;
  feeCurrency: string | null;
  feeEur: number | null;
  acquisitionValueEur: number | null;
  disposalValueEur: number | null;
  realizedPnlEur: number | null;
  dex: string | null;
  route: string[] | null;
  liveTradeId: string | null;
  lotDetails: { allocations: { lotId: string; quantity: string; costEur: number | null; holdingDays: number }[]; note?: string } | null;
}

export interface ArbTradeForTax {
  ts: number;
  signature: string;
  wallet: string;
  liveTradeId: string;
  solEur: number;
  solEurTs: number;
  /** Mint path, SOL first and last. */
  route: string[];
  dexes: string[];
  decimals: (mint: string) => number;
  /** SOL in (lamports) and SOL out of the closing leg (lamports). */
  inputLamports: bigint;
  outputLamports: bigint;
  /** Intermediate amounts per leg (raw) — from the executed route (quote amounts, see note). */
  intermediateAmounts: bigint[];
  /** Network fee + priority fee + Jito tip actually paid (lamports). */
  feesLamports: bigint;
}

const solEur = (lamports: bigint, price: number): number => (Number(lamports) / LAMPORTS_PER_SOL) * price;
const details = (allocs: Allocation[], note?: string): TaxRow["lotDetails"] => ({ allocations: allocs.map((a) => ({ lotId: a.lotId, quantity: a.quantity.toString(), costEur: a.costEur, holdingDays: a.holdingDays })), ...(note ? { note } : {}) });

/**
 * Tax documentation of live trades (never paper). An atomic arbitrage SOL → A (→ B) → SOL is
 * documented as consecutive swaps: each swap disposes of the given asset (FIFO cost basis) and
 * acquires the received asset at the EUR value of the exchange. Fees (network, priority, Jito tip)
 * are a separate SOL disposal.
 */
export class TaxLedger {
  constructor(readonly book: FifoBook = new FifoBook()) {}

  deposit(ts: number, signature: string, wallet: string, lamports: bigint, price: number, declaredCostEur: number | null): TaxRow {
    this.book.acquire(SOL_MINT, lamports, declaredCostEur, ts, "deposit", signature);
    return {
      ts, signature, walletAddress: wallet, kind: "deposit", assetIn: SOL_MINT, amountIn: lamports, assetInDecimals: 9, assetOut: null, amountOut: null, assetOutDecimals: null,
      eurValue: solEur(lamports, price), eurPrice: price, eurPriceTs: ts, fees: null, feeCurrency: null, feeEur: null,
      acquisitionValueEur: declaredCostEur, disposalValueEur: null, realizedPnlEur: null, dex: null, route: null, liveTradeId: null, lotDetails: null,
    };
  }

  recordArbitrage(t: ArbTradeForTax): TaxRow[] {
    if (t.route.length < 3 || t.route[0] !== SOL_MINT || t.route[t.route.length - 1] !== SOL_MINT) throw new Error("route must start and end in SOL");
    if (t.intermediateAmounts.length !== t.route.length - 2) throw new Error("one intermediate amount per intermediate asset required");
    const rows: TaxRow[] = [];
    const inValue = solEur(t.inputLamports, t.solEur);
    const outValue = solEur(t.outputLamports, t.solEur);
    // Value of every intermediate asset: the SOL given for it (all swaps happen in the same slot).
    let givenAsset = SOL_MINT;
    let givenAmount = t.inputLamports;
    let givenValue = inValue;
    for (let i = 1; i < t.route.length; i++) {
      const asset = t.route[i] as string;
      const isLast = i === t.route.length - 1;
      const received = isLast ? t.outputLamports : (t.intermediateAmounts[i - 1] as bigint);
      const receivedValue = isLast ? outValue : givenValue;
      const allocs = this.book.dispose(givenAsset, givenAmount, t.ts);
      const cost = totalCost(allocs);
      this.book.acquire(asset, received, receivedValue, t.ts, "swap", t.signature);
      rows.push({
        ts: t.ts,
        signature: t.signature,
        walletAddress: t.wallet,
        kind: "swap",
        assetIn: asset,
        amountIn: received,
        assetInDecimals: t.decimals(asset),
        assetOut: givenAsset,
        amountOut: givenAmount,
        assetOutDecimals: t.decimals(givenAsset),
        eurValue: receivedValue,
        eurPrice: t.solEur,
        eurPriceTs: t.solEurTs,
        fees: null,
        feeCurrency: null,
        feeEur: null,
        acquisitionValueEur: cost,
        disposalValueEur: receivedValue,
        realizedPnlEur: cost === null ? null : receivedValue - cost,
        dex: t.dexes[i - 1] ?? null,
        route: t.route,
        liveTradeId: t.liveTradeId,
        lotDetails: details(allocs, isLast ? undefined : "intermediate amount from the executed quote; valued at the SOL given in the same transaction"),
      });
      givenAsset = asset;
      givenAmount = received;
      givenValue = receivedValue;
    }
    if (t.feesLamports > 0n) {
      const allocs = this.book.dispose(SOL_MINT, t.feesLamports, t.ts);
      const cost = totalCost(allocs);
      const feeEur = solEur(t.feesLamports, t.solEur);
      rows.push({
        ts: t.ts, signature: t.signature, walletAddress: t.wallet, kind: "fee", assetIn: null, amountIn: null, assetInDecimals: null, assetOut: SOL_MINT, amountOut: t.feesLamports, assetOutDecimals: 9,
        eurValue: feeEur, eurPrice: t.solEur, eurPriceTs: t.solEurTs, fees: t.feesLamports, feeCurrency: "SOL", feeEur,
        acquisitionValueEur: cost, disposalValueEur: 0, realizedPnlEur: cost === null ? -feeEur : -cost, dex: null, route: t.route, liveTradeId: t.liveTradeId,
        lotDetails: details(allocs, "network fee, priority fee and Jito tip"),
      });
    }
    return rows;
  }
}

const CSV_COLUMNS: [string, (r: TaxRow) => string | number | null][] = [
  ["timestamp_utc", (r) => new Date(r.ts).toISOString()],
  ["signature", (r) => r.signature],
  ["wallet", (r) => r.walletAddress],
  ["kind", (r) => r.kind],
  ["asset_in", (r) => r.assetIn],
  ["amount_in", (r) => (r.amountIn === null ? null : ui(r.amountIn, r.assetInDecimals))],
  ["asset_out", (r) => r.assetOut],
  ["amount_out", (r) => (r.amountOut === null ? null : ui(r.amountOut, r.assetOutDecimals))],
  ["eur_value", (r) => r.eurValue],
  ["sol_eur", (r) => r.eurPrice],
  ["fee_sol", (r) => (r.fees === null ? null : ui(r.fees, 9))],
  ["fee_eur", (r) => r.feeEur],
  ["acquisition_value_eur", (r) => r.acquisitionValueEur],
  ["disposal_value_eur", (r) => r.disposalValueEur],
  ["realized_pnl_eur", (r) => r.realizedPnlEur],
  ["holding_days", (r) => (r.lotDetails?.allocations.length ? Math.min(...r.lotDetails.allocations.map((a) => a.holdingDays)) : null)],
  ["dex", (r) => r.dex],
  ["route", (r) => r.route?.join(">") ?? null],
  ["live_trade_id", (r) => r.liveTradeId],
];

function ui(raw: bigint, decimals: number | null): string {
  const d = decimals ?? 0;
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(d + 1, "0");
  const out = d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, "") : s;
  return neg ? `-${out}` : out;
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(8).replace(/\.?0+$/, "") : "") : v;
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: TaxRow[]): string {
  const lines = [`# ${TAX_DISCLAIMER}`, CSV_COLUMNS.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(","));
  return `${lines.join("\n")}\n`;
}

export function toJson(rows: TaxRow[], meta: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { disclaimer: TAX_DISCLAIMER, generatedAt: new Date().toISOString(), ...meta, rows },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}
