import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isRiskNotIncreased, mergeSettings } from "@solarbiter/shared";
import { silentLogger } from "@solarbiter/shared/node";
import type { Database } from "./database.js";
import { ensurePartitions, migrate } from "./migrate.js";
import { StateStore } from "./stateStore.js";
import { createTestDatabase } from "./testing.js";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe("database", () => {
  it("migrations are idempotent", async () => {
    expect(await migrate(db, silentLogger())).toBe(0);
  });

  it("partitions quotes and opportunities per UTC day", async () => {
    await ensurePartitions(db, "opportunities", new Date("2026-01-01T12:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    const parts = await db.many<{ relname: string }>(
      "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'opportunities' ORDER BY 1",
    );
    expect(parts.map((p) => p.relname)).toEqual(["opportunities_20260101", "opportunities_20260102"]);
  });

  it("trades and risk events cannot be deleted, tax rows and strategy parameters cannot be changed", async () => {
    await db.query(
      `INSERT INTO live_trades (id, opportunity_id, live_level, ts_detected, size_eur, sol_eur, input_lamports, predicted_output, min_output, predicted_net, status, route)
       VALUES ('t1', 'o1', 1, now(), 1, 100, 10000000, 10010000, 10005000, 5000, 'REJECTED', '[]')`,
    );
    await expect(db.query("DELETE FROM live_trades WHERE id = 't1'")).rejects.toThrow(/append-only/);
    await db.query("INSERT INTO risk_events (kind, severity, message) VALUES ('limit', 'warning', 'x')");
    await expect(db.query("UPDATE risk_events SET message = 'y'")).rejects.toThrow(/immutable/);
    await db.query(
      `INSERT INTO tax_transactions (ts, signature, wallet_address, kind, asset_in, amount_in) VALUES (now(), 'sig', 'w', 'swap', 'SOL', 1)`,
    );
    await expect(db.query("UPDATE tax_transactions SET amount_in = 2")).rejects.toThrow(/immutable/);
    await db.query("INSERT INTO strategy_versions (id, version, status, created_by) VALUES ('strategy_v1', 1, 'active', 'seed')");
    await db.query("INSERT INTO strategy_parameters (strategy_version_id, key, value) VALUES ('strategy_v1', 'minNetProfitEur', '0.01')");
    await expect(db.query("UPDATE strategy_parameters SET value = '0.02'")).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM strategy_versions")).rejects.toThrow(/append-only/);
  });

  it("stores settings with an audit trail and validates every update", async () => {
    const store = new StateStore(db);
    const s = await store.load({ capital: { maxTradeEur: 4 } });
    expect(s.capital.maxTradeEur).toBe(4);
    expect(s.capital.reserveCapitalEur).toBe(10);
    await store.update({ strategy: { minNetProfitEur: 0.02 } }, "tester");
    expect(store.get().strategy.minNetProfitEur).toBe(0.02);
    await expect(store.update({ capital: { maxTradeEur: -1 } }, "tester")).rejects.toThrow();
    const audit = await db.many<{ actor: string }>("SELECT actor FROM settings_audit ORDER BY id");
    expect(audit.map((a) => a.actor)).toEqual(["initial", "tester"]);
    await store.setState("bot", { state: "PAPER" });
    expect(await new StateStore(db).readState("bot", { state: "OFFLINE" })).toEqual({ state: "PAPER" });
  });

  it("detects any automatic increase of a user risk limit", () => {
    const base = DEFAULT_SETTINGS;
    expect(isRiskNotIncreased(base, mergeSettings(base, { capital: { maxTradeEur: 3 } }))).toBe(true);
    expect(isRiskNotIncreased(base, mergeSettings(base, { capital: { maxTradeEur: 6 } }))).toBe(false);
    expect(isRiskNotIncreased(base, mergeSettings(base, { risk: { dailyLossLimitEur: 1 } }))).toBe(false);
    expect(isRiskNotIncreased(base, mergeSettings(base, { risk: { liveLevel: 2 } }))).toBe(false);
    expect(isRiskNotIncreased(base, mergeSettings(base, { risk: { requireAtomic: false } }))).toBe(false);
    expect(isRiskNotIncreased(base, mergeSettings(base, { capital: { reserveCapitalEur: 12 } }))).toBe(true);
  });
});
