import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { silentLogger } from "../../core/logger.js";
import { TypedBus } from "../../core/bus.js";
import type { Database } from "../../db/database.js";
import type { BusEvents, DecisionPoint } from "../../app/busEvents.js";
import { ActivityLog } from "../activity/activityLog.js";
import { MarketState } from "../market/marketState.js";
import { StrategyService } from "../strategy/strategyService.js";
import { StateStore } from "../system/stateStore.js";
import { Ledger } from "../ledger/ledger.js";
import { TaxLedger } from "../tax/taxLedger.js";
import type { FxService } from "../tax/fx.js";
import type { ExecutionEngine, ExecuteRequest, ExecutionResult } from "../execution/executionEngine.js";
import type { WalletService } from "../wallet/walletService.js";
import type { RpcManager } from "../solana/rpcManager.js";
import { LiveEngine, LIVE_STATE_KEY } from "./liveEngine.js";
import { SyntheticToken } from "../../test/synthetic.js";

/**
 * Failure simulations for real-money trading (simulated chain):
 * failed exits, partial holdings, restart with open positions and RPC outages.
 */

let db: Database;
const bus = new TypedBus<BusEvents>();
const market = new MarketState();
const executed: ExecuteRequest[] = [];
let sellFailuresLeft = 0;
const rpc = { status: "CONNECTED" };
const holdings = new Map<string, { raw: bigint }>();
const mint = (i: number) => `FailMint${String(i).padStart(36, "A")}`;

const execution = {
  execute: async (req: ExecuteRequest): Promise<ExecutionResult> => {
    executed.push(req);
    const base = { orderId: `o${executed.length}`, status: "CONFIRMED" as const, signature: `sig${executed.length}`, feeLamports: 105_000, slot: 1, blockTime: 1, quote: null, error: null };
    if (req.kind === "buy") {
      holdings.set(req.mint as string, { raw: 300_000_000_000n });
      return { ...base, solDeltaLamports: -12_289_280, tokenDeltaRaw: 300_000_000_000n, costEstimate: { amountLamports: 10_000_000, priorityFeeLamports: 100_000, networkFeeLamports: 5_000, rentLamports: 2_039_280, priceImpactPct: 1, expectedOut: "300000000000", minOut: "1" } };
    }
    if (req.kind === "sell") {
      if (sellFailuresLeft > 0) {
        sellFailuresLeft--;
        return { ...base, status: "FAILED", signature: null, solDeltaLamports: null, tokenDeltaRaw: null, costEstimate: null, error: "slippage exceeded (custom 6001)" };
      }
      const h = holdings.get(req.mint as string);
      if (h) h.raw -= req.amount;
      return { ...base, solDeltaLamports: 11_000_000, tokenDeltaRaw: -req.amount, costEstimate: { amountLamports: 0, priorityFeeLamports: 100_000, networkFeeLamports: 5_000, rentLamports: 0, priceImpactPct: 1, expectedOut: "11100000", minOut: "1" } };
    }
    return { ...base, solDeltaLamports: 2_030_000, tokenDeltaRaw: null, costEstimate: null };
  },
} as unknown as ExecutionEngine;

const wallet = {
  signer: { publicKey: "BotWallet111111111111111111111111111111111" },
  address: "BotWallet111111111111111111111111111111111",
  lamports: 1_000_000_000,
  holdings,
  refresh: async () => undefined,
} as unknown as WalletService;

let store: StateStore;
let svc: StrategyService;

function newEngine(): LiveEngine {
  const fx = { solEur: async () => 150 } as unknown as FxService;
  return new LiveEngine(
    db,
    bus,
    market,
    svc,
    store,
    wallet,
    execution,
    new Ledger(db),
    new TaxLedger(db, fx),
    { componentStatus: () => rpc.status } as unknown as RpcManager,
    new ActivityLog(db, bus, silentLogger()),
    { now: () => Date.now() },
    silentLogger(),
    () => Date.now(),
  );
}

let engine: LiveEngine;

function dp(m: string): DecisionPoint {
  return { mint: m, ts: Date.now(), trigger: "periodic", eventId: null, eventUid: null, features: { signal: 1 }, regime: null, sampleId: null };
}

async function open(m: string): Promise<string> {
  await engine.onDecision(dp(m));
  await new Promise((r) => setTimeout(r, 200));
  const p = engine.openPositions.find((x) => x.mint === m);
  if (!p) throw new Error("position not opened");
  return p.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = new StateStore(db);
  await store.load();
  await store.update({ risk: { maxDataStalenessSec: 600, maxPortfolioExposureSol: 1, maxDailyLossSol: 1 } }, "test");
  svc = new StrategyService(db);
  const r = await svc.create({
    origin: "manual",
    name: "failure test",
    spec: {
      family: "recipe",
      universe: { venues: ["pump_curve"] },
      conditions: [{ kind: "feature", feature: "signal", op: "gte", value: 1 }],
      entry: { cooldownSec: 0 },
      exit: { takeProfitPct: 5, stopLossPct: 0.9, maxHoldSec: 3600, invalidation: [], expectedValueExit: false },
      horizonSec: 3600,
      params: {},
    },
  });
  const id = r?.strategyId as string;
  await svc.transition(id, "TESTING", "t", "user");
  await svc.transition(id, "PAPER_TRADING", "t", "system");
  await svc.transition(id, "PAPER_VALIDATED", "t", "system");
  await svc.transition(id, "LIVE_ENABLED", "user enabled", "user");
  for (let i = 0; i < 5; i++) {
    const tok = new SyntheticToken(mint(i), "c", Date.now() - 60_000);
    market.apply(tok.createEvent());
    const ev = tok.buy("x", 2_000_000_000n, Date.now());
    if (ev) market.apply(ev);
  }
  await store.setState(LIVE_STATE_KEY, { state: "ACTIVE" });
  engine = newEngine();
  await engine.start();
});

afterAll(async () => {
  await engine?.stop();
  await db?.close();
});

describe("live trading failure simulations", () => {
  it("a failed exit keeps the position open (no ledger close) and is retried", async () => {
    const id = await open(mint(0));
    sellFailuresLeft = 1;
    expect(await engine.closeById(id)).toBe(true);
    let t = await db.one<{ status: string }>("SELECT status FROM live_trades WHERE id = $1", [id]);
    expect(t?.status).toBe("OPEN");
    expect(engine.openPositions.some((p) => p.id === id)).toBe(true);
    const closes = await db.many("SELECT 1 FROM ledger_entries WHERE entry_type = 'TRADE_CLOSE' AND trade_id = $1", [id]);
    expect(closes).toHaveLength(0);

    expect(await engine.closeById(id)).toBe(true);
    t = await db.one<{ status: string }>("SELECT status FROM live_trades WHERE id = $1", [id]);
    expect(t?.status).toBe("CLOSED");
    expect(await db.many("SELECT 1 FROM ledger_entries WHERE entry_type = 'TRADE_CLOSE' AND trade_id = $1", [id])).toHaveLength(1);
  });

  it("partial holdings: sells what the wallet holds, records the shortfall and still closes the token account", async () => {
    const m = mint(1);
    const id = await open(m);
    holdings.set(m, { raw: 200_000_000_000n }); // 100k tokens missing (e.g. transfer fee / external movement)
    const before = executed.length;
    await engine.closeById(id);
    const calls = executed.slice(before);
    expect(calls.map((c) => c.kind)).toEqual(["sell", "close"]);
    expect(calls[0]?.amount).toBe(200_000_000_000n);
    const t = await db.one<{ status: string; actual: { shortfallRaw?: string } }>("SELECT status, actual FROM live_trades WHERE id = $1", [id]);
    expect(t?.status).toBe("CLOSED");
    expect(t?.actual.shortfallRaw).toBe("100000000000");
  });

  it("restores open and closing positions after a restart without buying again", async () => {
    const id2 = await open(mint(2));
    const id3 = await open(mint(3));
    await db.query("UPDATE live_trades SET status = 'CLOSING' WHERE id = $1", [id3]); // crashed mid-exit
    await engine.stop();
    const buysBefore = executed.filter((e) => e.kind === "buy").length;
    engine = newEngine();
    await engine.start();
    expect(engine.openPositions.map((p) => p.id).sort()).toEqual([id2, id3].sort());
    expect(executed.filter((e) => e.kind === "buy").length).toBe(buysBefore);
    // the interrupted exit can be completed
    expect(await engine.closeById(id3)).toBe(true);
    expect((await db.one<{ status: string }>("SELECT status FROM live_trades WHERE id = $1", [id3]))?.status).toBe("CLOSED");
  });

  it("an RPC outage blocks new entries and automatic exits", async () => {
    rpc.status = "DISCONNECTED";
    const before = executed.length;
    await engine.onDecision(dp(mint(4)));
    await new Promise((r) => setTimeout(r, 200));
    expect(executed.length).toBe(before);
    const id2 = engine.openPositions[0]?.id as string;
    await engine.closeById(id2);
    expect(executed.length).toBe(before);
    expect((await db.one<{ status: string }>("SELECT status FROM live_trades WHERE id = $1", [id2]))?.status).toBe("OPEN");
    const blocked = await db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM signals WHERE mint = $1 AND decision = 'NO_TRADE'", [mint(4)]);
    expect(blocked?.n).toBeGreaterThan(0);
    rpc.status = "CONNECTED";
  });
});
