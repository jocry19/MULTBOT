import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "./database.js";
import { ensurePartitions, migrate } from "./migrate.js";
import { createTestDatabase } from "../test/db.js";
import { silentLogger } from "../core/logger.js";

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  it("are idempotent", async () => {
    expect(await migrate(db, silentLogger())).toBe(0);
  });

  it("create daily partitions with UTC bounds", async () => {
    await ensurePartitions(db, "market_trades", new Date("2026-01-01T12:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    const parts = await db.many<{ relname: string }>(
      "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'market_trades' ORDER BY 1",
    );
    expect(parts.map((p) => p.relname)).toEqual(["market_trades_20260101", "market_trades_20260102"]);
    // a trade at 23:59:59 UTC lands in the 1 Jan partition
    await db.query(
      `INSERT INTO market_trades (signature, event_index, slot, ts, available_at, mint, venue, trader, is_buy, sol_amount, token_amount, price_sol, source)
       VALUES ('sig', 0, 1, '2026-01-01T23:59:59Z', '2026-01-02T00:00:01Z', 'm', 'pump_curve', 't', true, 1, 1, 0.1, 'live')`,
    );
    const r = await db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM market_trades_20260101");
    expect(r?.n).toBe(1);
  });

  it("insertMany chunks rows and respects ON CONFLICT", async () => {
    await ensurePartitions(db, "market_trades", new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    const rows = Array.from({ length: 5000 }, (_, i) => [
      `s${i}`, 0, i, "2026-01-03T10:00:00Z", "2026-01-03T10:00:01Z", "mint", "pump_curve", "trader", true, 1000, "1000000", 0.00001, "live",
    ]);
    const cols = ["signature", "event_index", "slot", "ts", "available_at", "mint", "venue", "trader", "is_buy", "sol_amount", "token_amount", "price_sol", "source"];
    expect(await db.insertMany("market_trades", cols, rows, "ON CONFLICT DO NOTHING")).toBe(5000);
    expect(await db.insertMany("market_trades", cols, rows.slice(0, 10), "ON CONFLICT DO NOTHING")).toBe(0);
  });
});

describe("ledger immutability", () => {
  it("rejects UPDATE and DELETE on ledger_entries", async () => {
    await db.query(
      "INSERT INTO ledger_entries (entry_type, data, prev_hash, hash) VALUES ('ADJUSTMENT', '{}', 'genesis', 'h1')",
    );
    await expect(db.query("UPDATE ledger_entries SET entry_type = 'X'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM ledger_entries")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE ledger_entries")).rejects.toThrow(/append-only/);
  });
});
