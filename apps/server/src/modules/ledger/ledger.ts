import { sha256Hex, stableStringify } from "../../core/hash.js";
import type { Database, Queryable } from "../../db/database.js";

/**
 * Immutable, hash-chained trading ledger (real money only).
 * Each entry's hash covers the previous hash and the canonical JSON of the entry, so any later
 * modification breaks the chain. The table itself rejects UPDATE/DELETE/TRUNCATE (DB trigger).
 */

export type LedgerEntryType = "TRADE_OPEN" | "TRADE_CLOSE" | "TRADE_FAILED" | "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT";

export interface LedgerTradeData {
  tradeId: string;
  timestamp: string;
  signature: string | null;
  wallet: string;
  token: string | null;
  mint: string;
  strategyId: string;
  strategyVersion: string;
  signalId: string | null;
  side: "entry" | "exit";
  quantityRaw: string | null;
  solValue: number | null;
  feesSol: number;
  priorityFeeSol: number;
  slippageSol: number;
  rentSol: number;
  executionPrice: number | null;
  expectedPrice: number | null;
  realizedPrice: number | null;
  grossPnlSol: number | null;
  netPnlSol: number | null;
  [k: string]: unknown;
}

const GENESIS = "GENESIS";
const LOCK_ID = 7_310_455_002;

export function entryHash(prevHash: string, entryType: string, tradeId: string | null, signature: string | null, data: unknown): string {
  return sha256Hex(`${prevHash}|${entryType}|${tradeId ?? ""}|${signature ?? ""}|${stableStringify(data)}`);
}

export class Ledger {
  constructor(private readonly db: Database) {}

  /** Append an entry (serialised by an advisory lock so the chain never forks). */
  async append(entryType: LedgerEntryType, data: Record<string, unknown>, tradeId: string | null = null, signature: string | null = null): Promise<{ id: number; hash: string }> {
    return this.db.tx(async (c: Queryable) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
      const last = await c.query<{ hash: string }>("SELECT hash FROM ledger_entries ORDER BY id DESC LIMIT 1");
      const prev = last.rows[0]?.hash ?? GENESIS;
      const hash = entryHash(prev, entryType, tradeId, signature, data);
      const res = await c.query<{ id: number }>(
        "INSERT INTO ledger_entries (entry_type, trade_id, signature, data, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [entryType, tradeId, signature, JSON.stringify(data), prev, hash],
      );
      return { id: res.rows[0]?.id as number, hash };
    });
  }

  /** Recompute the whole chain. Returns the first broken entry id (or null if intact). */
  async verify(): Promise<{ ok: boolean; entries: number; brokenAt: number | null }> {
    const rows = await this.db.many<{ id: number; entry_type: string; trade_id: string | null; signature: string | null; data: unknown; prev_hash: string; hash: string }>(
      "SELECT id, entry_type, trade_id, signature, data, prev_hash, hash FROM ledger_entries ORDER BY id",
    );
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev || entryHash(prev, r.entry_type, r.trade_id, r.signature, r.data) !== r.hash) {
        return { ok: false, entries: rows.length, brokenAt: r.id };
      }
      prev = r.hash;
    }
    return { ok: true, entries: rows.length, brokenAt: null };
  }
}
