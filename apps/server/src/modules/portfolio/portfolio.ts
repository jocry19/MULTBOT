import type { Database } from "../../db/database.js";
import type { MarketState } from "../market/marketState.js";
import { quoteCurveSell, quotePoolSell } from "../pumpfun/curve.js";

/**
 * Portfolio views. Paper and live are computed from separate tables and are never mixed.
 * Open positions are valued at their liquidation value (sell quote incl. DEX fee) when the curve or
 * pool state is known, otherwise at the last price.
 */

export interface PortfolioSummary {
  mode: "paper" | "live";
  capitalSol: number;
  cashSol: number;
  lockedSol: number;
  positionsValueSol: number;
  portfolioValueSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  todayPnlSol: number;
  totalPnlSol: number;
  grossPnlSol: number;
  feesSol: number;
  slippageSol: number;
  openPositions: number;
  closedTrades: number;
  failedTrades: number;
}

type OpenRow = { id: string; mint: string; token_qty: string | null; gross_entry_sol: number | null; position_size_sol: number; actual: { decimals?: number } | null; token_decimals?: number | null };

export function liquidationValue(market: MarketState, mint: string, tokenRaw: bigint, decimals: number): number {
  const t = market.tokens.get(mint);
  if (!t) return 0;
  const fee = t.lastFeeBps ?? 125;
  if (t.venue === "pump_curve" && t.curve && !t.curve.complete) return Number(quoteCurveSell(t.curve, tokenRaw, fee, decimals).solOutNet) / 1e9;
  if (t.venue === "pump_amm" && t.poolState) return Number(quotePoolSell(t.poolState, tokenRaw, fee).solOutNet) / 1e9;
  return (Number(tokenRaw) / 10 ** decimals) * t.lastPrice;
}

export async function portfolio(db: Database, market: MarketState, mode: "paper" | "live", opts: { walletLamports?: number | null; paperCapitalSol?: number }): Promise<PortfolioSummary & { positions: (OpenRow & { valueSol: number; unrealizedSol: number })[] }> {
  const table = mode === "paper" ? "paper_trades" : "live_trades";
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const agg = await db.one<{ realized: number | null; gross: number | null; fees: number | null; slippage: number | null; today: number | null; closed: number; failed: number }>(
    `SELECT sum(net_pnl_sol) FILTER (WHERE status IN ('CLOSED', 'FAILED')) AS realized,
            sum(gross_pnl_sol) FILTER (WHERE status = 'CLOSED') AS gross,
            sum(entry_fees_sol + exit_fees_sol + priority_fees_sol + network_fees_sol) FILTER (WHERE status IN ('CLOSED', 'FAILED')) AS fees,
            sum(entry_slippage_sol + exit_slippage_sol + mev_impact_sol) FILTER (WHERE status = 'CLOSED') AS slippage,
            sum(net_pnl_sol) FILTER (WHERE status IN ('CLOSED', 'FAILED') AND closed_at >= $1) AS today,
            count(*) FILTER (WHERE status = 'CLOSED')::int8 AS closed,
            count(*) FILTER (WHERE status = 'FAILED')::int8 AS failed
       FROM ${table}`,
    [today],
  );
  const open = await db.many<OpenRow>(`SELECT * FROM ${table} WHERE status IN ('OPEN', 'OPENING', 'CLOSING')`);
  let value = 0;
  let locked = 0;
  const positions = open.map((p) => {
    const decimals = p.token_decimals ?? p.actual?.decimals ?? 6;
    const v = p.token_qty ? liquidationValue(market, p.mint, BigInt(p.token_qty), decimals) : 0;
    const cost = p.gross_entry_sol ?? p.position_size_sol;
    value += v;
    locked += cost;
    return { ...p, valueSol: v, unrealizedSol: v - cost };
  });
  const realized = agg?.realized ?? 0;
  const unrealized = positions.reduce((s, p) => s + p.unrealizedSol, 0);
  const capital = mode === "paper" ? (opts.paperCapitalSol ?? 0) : (opts.walletLamports ?? 0) / 1e9 + locked;
  const cash = mode === "paper" ? capital + realized - locked : (opts.walletLamports ?? 0) / 1e9;
  return {
    mode,
    capitalSol: capital,
    cashSol: cash,
    lockedSol: locked,
    positionsValueSol: value,
    portfolioValueSol: cash + value,
    realizedPnlSol: realized,
    unrealizedPnlSol: unrealized,
    todayPnlSol: (agg?.today ?? 0) + unrealized,
    totalPnlSol: realized + unrealized,
    grossPnlSol: agg?.gross ?? 0,
    feesSol: agg?.fees ?? 0,
    slippageSol: agg?.slippage ?? 0,
    openPositions: open.length,
    closedTrades: agg?.closed ?? 0,
    failedTrades: agg?.failed ?? 0,
    positions,
  };
}
