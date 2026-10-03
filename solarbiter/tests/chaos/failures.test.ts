/**
 * Chaos tests: components fail at the worst moment. The system must fail safe — no trade, no
 * invented profit, bounded loss, breakers open, nothing executes twice.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import { OpportunityEvaluator, screen, type FeeModel } from "@solarbiter/arbitrage";
import { Database } from "@solarbiter/database";
import { DexRegistry } from "@solarbiter/dex";
import { JupiterClient } from "@solarbiter/jupiter";
import { LearningEngine } from "@solarbiter/learning-engine";
import { PaperExecutor, Portfolio, registryRequoter } from "@solarbiter/paper-engine";
import { BreakerBoard, RiskEngine, evaluateBreakers, type HealthInputs, type RiskContext } from "@solarbiter/risk-engine";
import { DEFAULT_SETTINGS, SOL_MINT, USDC_MINT, eurToLamports, lamportsToEur, type TokenInfo } from "@solarbiter/shared";
import { makeOpportunity } from "@solarbiter/shared/testing";
import { RedisBus } from "@solarbiter/shared/node";
import { DECIMALS, JUP, SimMarket } from "../helpers/simMarket.js";

const log = pino({ level: "silent" });
const SOL_EUR = 120;
const token: TokenInfo = { mint: JUP, symbol: "JUP", name: "", decimals: 6, program: "", mintAuthority: null, freezeAuthority: null, allowlisted: false, denylisted: false, safe: true, safetyReasons: [] };
const fees: FeeModel = { computeUnits: () => 3e5, priorityFeeLamports: () => 10_000n, jitoTipLamports: () => 10_000n, viaJito: () => true };

const ctx = (p: Portfolio, o: Partial<RiskContext> = {}): RiskContext => ({
  now: 1_000_000,
  mode: "paper",
  settings: DEFAULT_SETTINGS,
  botState: "PAPER",
  liveGate: "LIVE_LOCKED",
  liveModeEnabled: false,
  emergencyStop: false,
  blockingBreakers: [],
  solEur: SOL_EUR,
  balanceLamports: p.balanceLamports,
  capitalEur: lamportsToEur(p.balanceLamports, SOL_EUR),
  openTrades: p.openTrades,
  pnlTodayEur: 0,
  consecutiveFailures: 0,
  lossStreak: 0,
  lastTradeSizeEur: null,
  lastTradeLost: false,
  drawdownEur: 0,
  expectancyEur: null,
  token,
  liquidityDepthEur: null,
  viaJito: true,
  ...o,
});

/** A market with a clear, tradable mispricing and an executable opportunity. */
async function executable(seedBps = 140) {
  let t = 1_000_000;
  const now = () => t;
  const market = new SimMarket([
    { dex: "raydium", address: "r", solReserve: 2e12, tokenReserve: 2e12 * 1e-3 * 1000, feeRate: 0.0025 },
    { dex: "orca", address: "o", solReserve: 2e12, tokenReserve: 2e12 * 1e-3 * 1000 * (1 - seedBps / 10_000), feeRate: 0.0004 },
  ]);
  const registry = new DexRegistry().register(market.adapter("raydium", now)).register(market.adapter("orca", now));
  const learning = new LearningEngine(() => DEFAULT_SETTINGS, now);
  const ev = new OpportunityEvaluator(registry, fees, learning);
  const { candidates } = screen(market.states(t), { minNetSpreadBps: 8, direct: true, triangular: false, maxSwaps: 3, tradable: (m) => m === JUP, now: t });
  const c = candidates[0];
  if (!c) throw new Error("expected a candidate");
  const evalCtx = { mode: "paper" as const, settings: DEFAULT_SETTINGS, solEur: SOL_EUR, sizeCapEur: 4.5, strategyVersionId: null, rentLockedLamports: 0n, poolStateAgeMs: 0, volatilityBps: 0, decimals: (m: string) => DECIMALS[m], now };
  return { market, registry, ev, c, evalCtx, now, advance: (ms: number) => (t += ms) };
}

describe("chaos: market data and quote failures", () => {
  it("quote provider outage during evaluation → recorded rejection, no trade", async () => {
    const s = await executable();
    s.market.failing.add("orca");
    const { opportunity: o, verdict } = await s.ev.evaluate(s.c, s.evalCtx);
    expect(verdict.trade).toBe(false);
    expect(o.rejectionReason).toBe("ROUTE_UNAVAILABLE");
    expect(o.expectedNetProfit).toBe(0n);
  });

  it("stale quotes (slow provider) are rejected by the risk gate — no exception", async () => {
    const s = await executable();
    s.market.quoteDelayMs = DEFAULT_SETTINGS.strategy.maxQuoteAgeMs + 500;
    const { opportunity: o } = await s.ev.evaluate(s.c, s.evalCtx);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    const d = new RiskEngine().validate({ ...o, status: "EXECUTABLE" }, ctx(p));
    expect(d.codes).toContain("QUOTE_TOO_OLD");
  });

  it("re-quote outage during paper execution → outcome unknown, no profit invented", async () => {
    const s = await executable();
    const { opportunity: o, verdict } = await s.ev.evaluate(s.c, s.evalCtx);
    expect(verdict.trade).toBe(true);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    const risk = new RiskEngine();
    const d = risk.validate(o, ctx(p));
    expect(d.allowed).toBe(true);
    const exec = new PaperExecutor({
      risk,
      requote: registryRequoter(s.registry, (m) => DECIMALS[m], true),
      simulator: null,
      settings: () => DEFAULT_SETTINGS,
      latencyMs: () => 900,
      viaJito: () => true,
      now: s.now,
      sleep: async (ms) => {
        s.advance(ms);
        s.market.failing.add("raydium"); // provider dies while the trade is "in flight"
      },
    });
    const r = await exec.execute(o, d.approval, p);
    expect(r.success).toBeNull();
    expect(r.realizedNet).toBe(0n);
    expect(p.balanceLamports).toBe(eurToLamports(15, SOL_EUR));
    expect(p.openTrades).toBe(0);
  });

  it("price crash during the latency → atomic revert; via Jito nothing is lost", async () => {
    const s = await executable();
    const { opportunity: o } = await s.ev.evaluate(s.c, s.evalCtx);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    const risk = new RiskEngine();
    const d = risk.validate(o, ctx(p));
    const exec = new PaperExecutor({
      risk,
      requote: registryRequoter(s.registry, (m) => DECIMALS[m], true),
      simulator: null,
      settings: () => DEFAULT_SETTINGS,
      latencyMs: () => 900,
      viaJito: () => true,
      now: s.now,
      sleep: async (ms) => {
        s.advance(ms);
        s.market.drift = 0.95; // −5 % on every leg
      },
    });
    const r = await exec.execute(o, d.approval, p);
    expect(r.success).toBe(false);
    expect(r.failureReason).toMatch(/REVERTED/);
    expect(r.realizedNet).toBe(0n);
  });

  it("an approval can be used once only; a second execution of the same opportunity is refused", async () => {
    const s = await executable();
    const { opportunity: o } = await s.ev.evaluate(s.c, s.evalCtx);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    const risk = new RiskEngine();
    const d = risk.validate(o, ctx(p));
    const exec = new PaperExecutor({ risk, requote: registryRequoter(s.registry, (m) => DECIMALS[m], true), simulator: null, settings: () => DEFAULT_SETTINGS, latencyMs: () => 0, viaJito: () => true, now: s.now, sleep: async () => undefined });
    await exec.execute(o, d.approval, p);
    await expect(exec.execute(o, d.approval, p)).rejects.toThrow(/refused/);
  });

  it("concurrency: a second trade while one is open is rejected", async () => {
    const s = await executable();
    const { opportunity: o } = await s.ev.evaluate(s.c, s.evalCtx);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    p.open();
    expect(new RiskEngine().validate(o, ctx(p)).codes).toContain("CONCURRENCY_LIMIT");
  });

  it("emergency stop and paused state block every new trade", async () => {
    const s = await executable();
    const { opportunity: o } = await s.ev.evaluate(s.c, s.evalCtx);
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR));
    expect(new RiskEngine().validate(o, ctx(p, { emergencyStop: true })).codes).toContain("BOT_NOT_TRADING");
    expect(new RiskEngine().validate(o, ctx(p, { botState: "PAUSED" })).codes).toContain("BOT_NOT_TRADING");
    expect(new RiskEngine().validate(o, ctx(p, { botState: "EMERGENCY_STOP" })).codes).toContain("BOT_NOT_TRADING");
  });
});

describe("chaos: infrastructure failures open breakers", () => {
  const healthy: HealthInputs = {
    rpcHealthy: true,
    rpcLatencyMs: 150,
    quoteProviderAvailable: true,
    poolStateAgeMs: 500,
    poolPollMs: 2_000,
    dexUnavailable: [],
    solEurChange5mPct: 0.1,
    slippageDeviationsBps: [],
    recentTxFailures: [],
    jitoHealthy: true,
    databaseHealthy: true,
    redisHealthy: true,
    walletMatches: true,
    balanceMatches: true,
  };
  const cases: [Partial<HealthInputs>, string][] = [
    [{ rpcHealthy: false }, "RPC_OUTAGE"],
    [{ rpcLatencyMs: 8_000 }, "LATENCY_SPIKE"],
    [{ quoteProviderAvailable: false }, "QUOTE_OUTAGE"],
    [{ poolStateAgeMs: 120_000 }, "STALE_QUOTES"],
    [{ dexUnavailable: ["orca"] }, "DEX_OUTAGE"],
    [{ solEurChange5mPct: -7 }, "UNEXPECTED_PRICE_MOVE"],
    [{ databaseHealthy: false }, "DATABASE_FAILURE"],
    [{ redisHealthy: false }, "REDIS_FAILURE"],
    [{ jitoHealthy: false }, "JITO_PROBLEM"],
    [{ walletMatches: false }, "WALLET_MISMATCH"],
    [{ balanceMatches: false }, "BALANCE_MISMATCH"],
    [{ recentTxFailures: [true, true, true] }, "TX_FAILURE_SPIKE"],
    [{ slippageDeviationsBps: [40, 50, 60, 45, 30] }, "UNEXPECTED_SLIPPAGE"],
  ];
  for (const [fault, breaker] of cases) {
    it(`${breaker}`, () => {
      const b = new BreakerBoard(() => 0);
      evaluateBreakers(b, { ...healthy, ...fault });
      expect(b.open()).toContain(breaker);
      const p = new Portfolio("live", 1n);
      const d = new RiskEngine().validate(makeOpportunity({ mode: "live" }), ctx(p, { mode: "live", blockingBreakers: b.blocking("live") }));
      expect(d.codes).toContain("CIRCUIT_BREAKER");
    });
  }

  it("a real database outage is detected (unreachable PostgreSQL)", async () => {
    const db = new Database("postgres://nobody:nothing@127.0.0.1:1/none", log);
    expect(await db.ping()).toBe(false);
    await db.close();
  });

  it("a real Redis outage is detected (unreachable Redis)", async () => {
    const bus = new RedisBus("redis://127.0.0.1:1", log);
    await expect(bus.connect()).rejects.toThrow();
    expect(bus.isHealthy).toBe(false);
    await bus.close().catch(() => undefined);
  });

  it("a 429 storm from the routing API opens the Jupiter circuit (adapter reports unavailable)", async () => {
    const f = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const jc = new JupiterClient({ baseUrl: "https://x.test", rps: 100, log, fetchImpl: f });
    const req = { inputMint: SOL_MINT, outputMint: USDC_MINT, inputDecimals: 9, outputDecimals: 6, amount: 1_000_000n, slippageBps: 30, onlyDirectRoutes: true, priority: "final" as const };
    for (let i = 0; i < 5; i++) await expect(jc.quote(req, null, "jupiter")).rejects.toThrow(/rate limited/);
    expect(jc.available().ok).toBe(false);
  });
});
