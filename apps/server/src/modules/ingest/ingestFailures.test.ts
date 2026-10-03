import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TypedBus } from "../../core/bus.js";
import { silentLogger } from "../../core/logger.js";
import { Database } from "../../db/database.js";
import type { BusEvents } from "../../app/busEvents.js";
import type { MarketEvent, MarketTrade } from "../../domain/market.js";
import type { SolanaWsClient } from "../solana/wsClient.js";
import { DataCollector } from "./collector.js";
import { PoolRegistry } from "./poolRegistry.js";
import { PumpStream } from "./pumpStream.js";

/** Failure simulations for data ingestion: duplicate delivery, database outages, buffer overflow. */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, "../pumpfun/__fixtures__/mainnet-events.json"), "utf8")) as Record<
  string,
  { signature: string; slot: number; logMessages: string[] }
>;

function trade(i: number): MarketTrade {
  return {
    signature: `sig${i}`,
    slot: i,
    availableAt: Date.UTC(2026, 0, 1, 12) + i,
    source: "live",
    eventIndex: 0,
    ts: Date.UTC(2026, 0, 1, 12) + i,
    mint: "mint",
    venue: "pump_curve",
    pool: null,
    trader: "t",
    isBuy: true,
    solAmount: 1_000_000n,
    tokenAmount: 1_000_000n,
    feeLamports: 12_500n,
    feeBps: 125,
    priceSol: 1e-7,
    marketCapSol: 100,
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_000_000_000_000_000n,
    realSolReserves: 0n,
    realTokenReserves: 0n,
    tokenDecimals: 6,
    tokenSupply: 1_000_000_000_000_000n,
    ixName: null,
    mayhemMode: false,
  } as MarketTrade;
}

const events = (n: number): MarketEvent[] => Array.from({ length: n }, (_, i) => ({ kind: "trade", data: trade(i) }) as MarketEvent);

/** Minimal database double: fails the first `failures` writes, records rows afterwards. */
function flakyDb(failures: number) {
  const rows: unknown[][] = [];
  const gaps: unknown[][] = [];
  let left = failures;
  const fail = () => {
    if (left > 0) {
      left--;
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    }
  };
  const db = {
    query: async () => {
      fail();
      return { rows: [], rowCount: 0 };
    },
    insertMany: async (table: string, _cols: string[], r: unknown[][]) => {
      fail();
      if (table === "market_trades") rows.push(...r);
      if (table === "data_gaps") gaps.push(...r);
      return r.length;
    },
  };
  return { db: db as unknown as Database, rows, gaps };
}

describe("ingest failure simulations", () => {
  it("processes a transaction delivered twice (two subscriptions / reconnect) exactly once and ignores failed transactions", () => {
    const bus = new TypedBus<BusEvents>();
    const emitted: MarketEvent[][] = [];
    bus.on("market.events", (e) => void emitted.push(e));
    const stream = new PumpStream({} as SolanaWsClient, new PoolRegistry(null, null, silentLogger()), bus, { now: () => Date.now() }, silentLogger());
    const fx = fixtures.TradeEventBuy as { signature: string; slot: number; logMessages: string[] };
    const n = { context: { slot: fx.slot }, value: { signature: fx.signature, err: null, logs: fx.logMessages } };
    stream.onLogs(n);
    stream.onLogs(n);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.some((e) => e.kind === "trade")).toBe(true);
    stream.onLogs({ ...n, value: { ...n.value, signature: "failedTx", err: { InstructionError: [0, "Custom"] } } });
    expect(emitted).toHaveLength(1);
  });

  it("keeps buffered market data through a database outage and writes it once afterwards", async () => {
    const { db, rows } = flakyDb(1);
    const c = new DataCollector(db, new TypedBus<BusEvents>(), silentLogger());
    c.accept(events(50));
    await expect(c.flush()).rejects.toThrow(/ECONNREFUSED/);
    expect(c.buffered).toBe(50);
    c.accept(events(60).slice(50)); // new data arrives during the outage
    await c.flush();
    expect(c.buffered).toBe(0);
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((r) => r[0])).size).toBe(60);
  });

  it("bounds the buffer during a long outage and records the loss as a data gap", async () => {
    const { db, gaps } = flakyDb(0);
    const c = new DataCollector(db, new TypedBus<BusEvents>(), silentLogger(), () => [], 100);
    c.accept(events(150));
    expect(c.buffered).toBe(100);
    expect(c.dropped).toBe(50);
    await c.flush();
    expect(gaps).toHaveLength(1);
    expect(String(gaps[0]?.[3])).toMatch(/database unavailable/);
  });

  it("reports an unreachable database as unhealthy instead of hanging or crashing", async () => {
    const db = new Database("postgres://multbot:multbot@127.0.0.1:1/none", silentLogger(), 1);
    expect(await db.ping()).toBe(false);
    expect(db.isHealthy).toBe(false);
    await expect(db.query("SELECT 1")).rejects.toThrow();
    await db.close();
  });
});
