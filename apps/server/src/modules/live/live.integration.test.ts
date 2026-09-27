import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "@multbot/shared";
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
import { checkEntry, type RiskSnapshot } from "../risk/riskEngine.js";
import { SyntheticToken } from "../../test/synthetic.js";

let db: Database;
let strategyId: string;
const bus = new TypedBus<BusEvents>();
const market = new MarketState();
const executed: ExecuteRequest[] = [];
const MINT = "LiveMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = Date.now();

function fakeExecution(): ExecutionEngine {
  return {
    execute: async (req: ExecuteRequest): Promise<ExecutionResult> => {
      executed.push(req);
      const base = { orderId: `o${executed.length}`, status: "CONFIRMED" as const, signature: `sig${executed.length}`, feeLamports: 105_000, slot: 1, blockTime: 1, quote: null, error: null };
      if (req.kind === "buy") return { ...base, solDeltaLamports: -10_250_000 - 2_039_280, tokenDeltaRaw: 300_000_000_000n, costEstimate: { amountLamports: 10_000_000, priorityFeeLamports: 100_000, networkFeeLamports: 5_000, rentLamports: 2_039_280, priceImpactPct: 1, expectedOut: "300000000000", minOut: "1" } };
      if (req.kind === "sell") return { ...base, solDeltaLamports: 14_000_000, tokenDeltaRaw: -300_000_000_000n, costEstimate: { amountLamports: 0, priorityFeeLamports: 100_000, networkFeeLamports: 5_000, rentLamports: 0, priceImpactPct: 1, expectedOut: "14200000", minOut: "1" } };
      return { ...base, solDeltaLamports: 2_030_000, tokenDeltaRaw: null, costEstimate: null };
    },
  } as unknown as ExecutionEngine;
}

const fakeWallet = {
  signer: { publicKey: "BotWallet111111111111111111111111111111111" },
  address: "BotWallet111111111111111111111111111111111",
  lamports: 1_000_000_000,
  holdings: new Map(),
  refresh: async () => undefined,
} as unknown as WalletService;

const fakeRpc = { componentStatus: () => "CONNECTED" } as unknown as RpcManager;

let engine: LiveEngine;
let store: StateStore;

function dp(ts: number, signal = 1): DecisionPoint {
  return { mint: MINT, ts, trigger: "periodic", eventId: null, eventUid: null, features: { signal }, regime: null, sampleId: null };
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = new StateStore(db);
  await store.load();
  await store.update({ risk: { maxDataStalenessSec: 600 } }, "test");
  const svc = new StrategyService(db);
  const r = await svc.create({
    origin: "manual",
    name: "live test",
    spec: {
      family: "recipe",
      universe: { venues: ["pump_curve"] },
      conditions: [{ kind: "feature", feature: "signal", op: "gte", value: 1 }],
      entry: { cooldownSec: 0 },
      exit: { takeProfitPct: 0.3, stopLossPct: 0.2, maxHoldSec: 600, invalidation: [], expectedValueExit: false },
      horizonSec: 600,
      params: {},
    },
  });
  strategyId = r!.strategyId;
  await svc.transition(strategyId, "TESTING", "t", "user");
  await svc.transition(strategyId, "PAPER_TRADING", "t", "system");
  await svc.transition(strategyId, "PAPER_VALIDATED", "t", "system");
  await svc.transition(strategyId, "LIVE_ENABLED", "user enabled", "user");
  const tok = new SyntheticToken(MINT, "c", now - 60_000);
  market.apply(tok.createEvent());
  const ev = tok.buy("x", 2_000_000_000n, Date.now());
  if (ev) market.apply(ev);
  const fx = { solEur: async () => 150 } as unknown as FxService;
  engine = new LiveEngine(db, bus, market, svc, store, fakeWallet, fakeExecution(), new Ledger(db), new TaxLedger(db, fx), fakeRpc, new ActivityLog(db, bus, silentLogger()), { now: () => Date.now() }, silentLogger(), () => Date.now());
  await engine.start();
});

afterAll(async () => {
  await engine?.stop();
  await db?.close();
});

describe("live trading engine (integration, simulated chain)", () => {
  it("does nothing while real money mode is LOCKED", async () => {
    expect(engine.liveState).toBe("LOCKED");
    await engine.onDecision(dp(Date.now()));
    expect(executed).toHaveLength(0);
  });

  it("opens a position after unlock, records ledger + tax, and never duplicates a decision point", async () => {
    await store.setState(LIVE_STATE_KEY, { state: "ACTIVE" });
    const ts = Date.now();
    await engine.onDecision(dp(ts));
    await engine.onDecision(dp(ts)); // duplicate decision point
    await new Promise((r) => setTimeout(r, 300));
    expect(executed.filter((e) => e.kind === "buy")).toHaveLength(1);
    const t = await db.one<{ status: string; token_qty: string; gross_entry_sol: number }>("SELECT status, token_qty, gross_entry_sol FROM live_trades");
    expect(t?.status).toBe("OPEN");
    expect(t?.token_qty).toBe("300000000000");
    expect(engine.openPositions).toHaveLength(1);
    const ledger = await db.many<{ entry_type: string }>("SELECT entry_type FROM ledger_entries");
    expect(ledger.map((l) => l.entry_type)).toContain("TRADE_OPEN");
    const lots = await db.many("SELECT * FROM tax_lots WHERE asset = $1", [MINT]);
    expect(lots).toHaveLength(1);
  });

  it("blocks new entries during an emergency stop and records NO_TRADE", async () => {
    await store.update({ risk: { emergencyStop: true, emergencyStopClosePositions: false } }, "test");
    const before = executed.length;
    await engine.onDecision({ ...dp(Date.now() + 1), mint: MINT });
    expect(executed.length).toBe(before);
    const noTrade = await db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM signals WHERE decision = 'NO_TRADE'");
    expect(noTrade!.n).toBeGreaterThan(0);
    await store.update({ risk: { emergencyStop: false } }, "test");
  });

  it("takes profit, closes the token account, and writes a verifiable ledger", async () => {
    const pos = engine.openPositions[0]!;
    bus.emit("market.price", { mint: MINT, ts: Date.now(), priceSol: pos.entryPrice * 2, liquiditySol: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const t = await db.one<{ status: string; exit_reason: string; net_pnl_sol: number; gross_pnl_sol: number; exit_rent_refund_sol: number }>(
      "SELECT status, exit_reason, net_pnl_sol, gross_pnl_sol, exit_rent_refund_sol FROM live_trades",
    );
    expect(t?.status).toBe("CLOSED");
    expect(t?.exit_reason).toBe("TAKE_PROFIT");
    expect(executed.map((e) => e.kind)).toEqual(["buy", "sell", "close"]);
    expect(t!.exit_rent_refund_sol).toBeCloseTo(0.00203, 5);
    // net = received + rent refund − cost
    expect(t!.net_pnl_sol).toBeCloseTo(0.014 + 0.00203 - 0.01228928, 6);
    expect(t!.gross_pnl_sol).toBeGreaterThan(t!.net_pnl_sol);
    expect(await new Ledger(db).verify()).toMatchObject({ ok: true });
    const disposals = await db.many("SELECT * FROM tax_disposals WHERE asset = $1", [MINT]);
    expect(disposals).toHaveLength(1);
  });
});

describe("risk engine", () => {
  const base = (over: Partial<RiskSnapshot> = {}): RiskSnapshot => ({
    now: Date.UTC(2026, 0, 5, 12),
    settings: mergeSettings(DEFAULT_SETTINGS, {}),
    liveState: "ACTIVE",
    botRunning: true,
    reconciliation: "OK",
    walletLamports: 1_000_000_000,
    openPositions: [],
    realizedTodaySol: 0,
    unrealizedSol: 0,
    tokenDataAt: Date.UTC(2026, 0, 5, 12) - 1000,
    rpcHealthy: true,
    strategy: { id: "S-1", versionId: "S-1@1.0", status: "LIVE_ENABLED", liveEnabled: true },
    ...over,
  });
  const req = { mint: "m", positionSizeSol: 0.01, expectedPriceImpactBps: 100, estimatedFeesSol: 0.002 };

  it("allows a clean entry", () => {
    expect(checkEntry(base(), req)).toMatchObject({ allowed: true, reasons: [] });
  });

  it.each<[string, Partial<RiskSnapshot>, RegExp]>([
    ["locked", { liveState: "LOCKED" }, /LOCKED/],
    ["max positions", { openPositions: Array.from({ length: 10 }, (_, i) => ({ mint: `x${i}`, costSol: 0.001 })) }, /max open positions/],
    ["daily loss", { realizedTodaySol: -0.06 }, /daily loss/],
    ["insufficient SOL", { walletLamports: 20_000_000 }, /insufficient SOL/],
    ["stale data", { tokenDataAt: Date.UTC(2026, 0, 5, 11) }, /stale/],
    ["reconciliation", { reconciliation: "REQUIRED" }, /reconciliation/],
    ["strategy not live", { strategy: { id: "S-1", versionId: "v", status: "PAPER_VALIDATED", liveEnabled: false } }, /not enabled/],
    ["bot stopped", { botRunning: false }, /stopped/],
    ["duplicate token", { openPositions: [{ mint: "m", costSol: 0.01 }] }, /already holding/],
  ])("blocks: %s", (_name, over, re) => {
    const d = checkEntry(base(over), req);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join("; ")).toMatch(re);
  });

  it("respects trading hours and slippage limits", () => {
    const s: Settings = mergeSettings(DEFAULT_SETTINGS, { risk: { tradingHours: { enabled: true, startUtc: "14:00", endUtc: "16:00", days: [1] } } });
    expect(checkEntry(base({ settings: s }), req).reasons.join()).toMatch(/trading hours/);
    expect(checkEntry(base(), { ...req, expectedPriceImpactBps: 9000 }).reasons.join()).toMatch(/slippage/);
  });
});
