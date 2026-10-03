import type { Database } from "../../db/database.js";
import type { StateTrade } from "../execution/simulator.js";

type TradeRow = {
  mint: string;
  ts: Date;
  venue: "pump_curve" | "pump_amm";
  price_sol: number;
  fee_bps: number | null;
  virtual_sol_reserves: number | null;
  virtual_token_reserves: string | null;
  real_sol_reserves: number | null;
  real_token_reserves: string | null;
  decimals: number | null;
  total_supply: string | null;
};

/** Load state-defining trades for many mints in [from, to], grouped by mint and sorted by time. */
export async function loadStateTrades(
  db: Database,
  mints: string[],
  from: Date,
  to: Date,
): Promise<Map<string, StateTrade[]>> {
  const out = new Map<string, StateTrade[]>();
  if (mints.length === 0) return out;
  const rows = await db.many<TradeRow>(
    `SELECT t.mint, t.ts, t.venue, t.price_sol, t.fee_bps, t.virtual_sol_reserves, t.virtual_token_reserves,
            t.real_sol_reserves, t.real_token_reserves, k.decimals, k.total_supply
       FROM market_trades t LEFT JOIN tokens k ON k.mint = t.mint
      WHERE t.mint = ANY($1) AND t.ts >= $2 AND t.ts <= $3
      ORDER BY t.mint, t.ts, t.slot, t.event_index`,
    [mints, from, to],
  );
  for (const r of rows) {
    let arr = out.get(r.mint);
    if (!arr) {
      arr = [];
      out.set(r.mint, arr);
    }
    arr.push({
      ts: r.ts.getTime(),
      venue: r.venue,
      priceSol: r.price_sol,
      feeBps: r.fee_bps,
      virtualSolReserves: r.virtual_sol_reserves === null ? null : BigInt(r.virtual_sol_reserves),
      virtualTokenReserves: r.virtual_token_reserves === null ? null : BigInt(r.virtual_token_reserves),
      realSolReserves: r.real_sol_reserves === null ? null : BigInt(r.real_sol_reserves),
      realTokenReserves: r.real_token_reserves === null ? null : BigInt(r.real_token_reserves),
      decimals: r.decimals ?? 6,
      supply: r.total_supply ? BigInt(r.total_supply) : 1_000_000_000_000_000n,
    });
  }
  return out;
}

export interface Gap {
  start: number;
  end: number;
}

export async function loadGaps(db: Database, from: Date, to: Date): Promise<Gap[]> {
  const rows = await db.many<{ gap_start: Date; gap_end: Date }>(
    "SELECT gap_start, gap_end FROM data_gaps WHERE gap_end >= $1 AND gap_start <= $2 AND NOT backfilled",
    [from, to],
  );
  return rows.map((r) => ({ start: r.gap_start.getTime(), end: r.gap_end.getTime() }));
}

export function overlapsGap(gaps: Gap[], from: number, to: number): boolean {
  return gaps.some((g) => g.start <= to && g.end >= from);
}
