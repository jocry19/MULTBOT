import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, solToLamports, type TokenInfo } from "@solarbiter/shared";
import { TEST_TOKEN, makeOpportunity } from "@solarbiter/shared/testing";
import { AUTO_CLOSE_AFTER_MS, BreakerBoard, evaluateBreakers, type HealthInputs } from "./breakers.js";
import { evaluateLiveLevel, levelUpEligibility, type LevelTradeStats } from "./liveLevels.js";
import { RiskEngine, type RiskContext } from "./riskEngine.js";
import { effectiveMaxTradeEur, scalingCapEur, scalingSuggestion } from "./sizing.js";

const token: TokenInfo = { mint: TEST_TOKEN, symbol: "JUP", name: "Jupiter", decimals: 6, program: "Tokenkeg", mintAuthority: null, freezeAuthority: null, allowlisted: false, denylisted: false, safe: true, safetyReasons: [] };

const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: 1_000,
  mode: "paper",
  settings: DEFAULT_SETTINGS,
  botState: "PAPER",
  liveGate: "LIVE_LOCKED",
  liveModeEnabled: false,
  emergencyStop: false,
  blockingBreakers: [],
  solEur: 120,
  balanceLamports: solToLamports(15 / 120),
  capitalEur: 15,
  openTrades: 0,
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

describe("RiskEngine.validate", () => {
  it("approves a clean opportunity and binds the approval to it", () => {
    const risk = new RiskEngine();
    const opp = makeOpportunity();
    const d = risk.validate(opp, ctx());
    expect(d.reasons).toEqual([]);
    expect(d.allowed).toBe(true);
    expect(risk.consumeApproval(d.approval, opp, 1_100).ok).toBe(true);
    // single use
    expect(risk.consumeApproval(d.approval, opp, 1_100).ok).toBe(false);
  });

  it("an approval cannot be forged, reused for another opportunity, or used after changes/expiry", () => {
    const risk = new RiskEngine();
    const opp = makeOpportunity();
    const forged = { id: "x", opportunityId: opp.id, mode: "paper" as const, fingerprint: "f", issuedAt: 0, expiresAt: 1e15 };
    expect(risk.consumeApproval(forged, opp, 1_000).reason).toMatch(/not issued/);
    const a = risk.validate(opp, ctx()).approval;
    expect(risk.consumeApproval(a, { ...opp, jitoTip: 1n }, 1_000).reason).toMatch(/changed/);
    const b = risk.validate(opp, ctx()).approval;
    expect(risk.consumeApproval(b, opp, 1_000 + 5_000).reason).toMatch(/expired/);
    expect(risk.consumeApproval(null, opp, 1_000).ok).toBe(false);
  });

  const reject = (o: Parameters<typeof makeOpportunity>[0], c: Partial<RiskContext> = {}) => new RiskEngine().validate(makeOpportunity(o), ctx(c)).codes;

  it("NO NET EDGE = NO TRADE", () => {
    expect(reject({ expectedNetProfit: 0n, expectedNetProfitEur: 0 })).toContain("NET_PROFIT_BELOW_THRESHOLD");
    expect(reject({ expectedNetProfit: -5n, expectedNetProfitEur: -0.001 })).toContain("NET_PROFIT_BELOW_THRESHOLD");
  });

  it("rejects stale quotes without exception", () => {
    expect(reject({ quoteAge: DEFAULT_SETTINGS.strategy.maxQuoteAgeMs + 1 })).toContain("QUOTE_TOO_OLD");
  });

  it("enforces reserve, concurrency, daily loss, consecutive failures and per-trade loss", () => {
    expect(reject({}, { balanceLamports: solToLamports(14 / 120) })).toContain("WALLET_RESERVE");
    expect(reject({}, { openTrades: 1 })).toContain("CONCURRENCY_LIMIT");
    expect(reject({}, { pnlTodayEur: -0.75 })).toContain("DAILY_LOSS_LIMIT");
    expect(reject({}, { consecutiveFailures: 3 })).toContain("RISK_LIMIT");
    // non-atomic worst case: 5 € × (0.5 % slippage + 0.5 % buffer + 5 % inventory risk) + fees > 0.30 €
    const s = mergeSettings(DEFAULT_SETTINGS, { risk: { requireAtomic: false } });
    const d = new RiskEngine().validate(makeOpportunity({ atomic: false, sizeEur: 5, inputAmount: 41_666_667n }), ctx({ settings: s, balanceLamports: solToLamports(16 / 120), capitalEur: 16 }));
    expect(d.codes).toEqual(["RISK_LIMIT"]);
    expect(d.reasons[0]).toMatch(/worst-case loss/);
    expect(reject({ atomic: false, sizeEur: 1, inputAmount: 8_333_333n }, { settings: s })).toEqual([]);
    expect(reject({ atomic: false })).toContain("NOT_ATOMIC");
  });

  it("size limits: user max, reserve and no martingale after a loss", () => {
    expect(reject({ sizeEur: 5.5 })).toContain("RISK_LIMIT");
    expect(reject({ sizeEur: 4.8 }, { lastTradeLost: true, lastTradeSizeEur: 2 })).toContain("RISK_LIMIT");
    expect(reject({ sizeEur: 2 }, { lastTradeLost: true, lastTradeSizeEur: 2 })).toEqual([]);
  });

  it("live requires env switch + manual gate + LIVE state; paper never touches the live gate", () => {
    expect(reject({ mode: "live" }, { mode: "live", botState: "LIVE", liveGate: "LIVE_READY", liveModeEnabled: true })).toContain("BOT_NOT_TRADING");
    expect(reject({ mode: "live" }, { mode: "live", botState: "LIVE", liveGate: "LIVE_ENABLED", liveModeEnabled: false })).toContain("BOT_NOT_TRADING");
    // level 1 caps live trades at 1 €
    expect(reject({ mode: "live" }, { mode: "live", botState: "LIVE", liveGate: "LIVE_ENABLED", liveModeEnabled: true })).toContain("RISK_LIMIT");
    expect(reject({ mode: "live", sizeEur: 1 }, { mode: "live", botState: "LIVE", liveGate: "LIVE_ENABLED", liveModeEnabled: true })).toEqual([]);
    expect(reject({ mode: "live" }, { mode: "paper" })).toContain("RISK_LIMIT");
  });

  it("emergency stop, breakers, unsafe tokens and bot state block everything", () => {
    expect(reject({}, { emergencyStop: true })).toContain("BOT_NOT_TRADING");
    expect(reject({}, { botState: "PAUSED" })).toContain("BOT_NOT_TRADING");
    expect(reject({}, { blockingBreakers: ["RPC_OUTAGE"] })).toContain("CIRCUIT_BREAKER");
    expect(reject({}, { token: { ...token, safe: false, safetyReasons: ["freeze authority"] } })).toContain("TOKEN_REJECTED");
    expect(reject({}, { token: undefined })).toContain("TOKEN_REJECTED");
  });
});

describe("sizing", () => {
  it("capital scaling table (non-linear)", () => {
    expect([15, 20, 30, 50, 100, 250].map(scalingCapEur)).toEqual([5, 6, 8, 12, 20, 20]);
    expect(scalingCapEur(9)).toBeCloseTo(3, 6);
  });

  it("scaling never raises the user's limit — it only suggests", () => {
    const base = { mode: "paper" as const, settings: DEFAULT_SETTINGS, liquidityDepthEur: null, drawdownEur: 0, expectancyEur: null, lossStreak: 0, lastTradeSizeEur: null, lastTradeLost: false };
    expect(effectiveMaxTradeEur({ ...base, capitalEur: 100 }).capEur).toBe(5);
    expect(scalingSuggestion(100, DEFAULT_SETTINGS)).toEqual({ suggestedMaxTradeEur: 20, requiresUserConfirmation: true });
    expect(scalingSuggestion(15, DEFAULT_SETTINGS)).toBeNull();
    // reductions
    expect(effectiveMaxTradeEur({ ...base, capitalEur: 15, lossStreak: 3 }).capEur).toBeCloseTo(1.25, 6);
    expect(effectiveMaxTradeEur({ ...base, capitalEur: 15, liquidityDepthEur: 8 }).binding).toBe("liquidity");
    expect(effectiveMaxTradeEur({ ...base, capitalEur: 15, expectancyEur: -0.01 }).capEur).toBe(0.5);
    expect(effectiveMaxTradeEur({ ...base, capitalEur: 12 }).capEur).toBe(2); // reserve 10 €
  });
});

describe("circuit breakers", () => {
  const healthy: HealthInputs = {
    rpcHealthy: true,
    rpcLatencyMs: 200,
    quoteProviderAvailable: true,
    poolStateAgeMs: 1_000,
    poolPollMs: 2_000,
    dexUnavailable: [],
    solEurChange5mPct: 0.2,
    slippageDeviationsBps: [],
    recentTxFailures: [],
    jitoHealthy: true,
    databaseHealthy: true,
    redisHealthy: true,
    walletMatches: true,
    balanceMatches: true,
  };

  it("automatic breakers open immediately and close only after a healthy period", () => {
    let t = 0;
    const b = new BreakerBoard(() => t);
    evaluateBreakers(b, { ...healthy, rpcHealthy: false });
    expect(b.open()).toEqual(["RPC_OUTAGE"]);
    t += 1_000;
    evaluateBreakers(b, healthy);
    expect(b.isOpen("RPC_OUTAGE")).toBe(true);
    t += AUTO_CLOSE_AFTER_MS;
    evaluateBreakers(b, healthy);
    expect(b.isOpen("RPC_OUTAGE")).toBe(false);
  });

  it("money-protecting breakers need a manual reset; live-only breakers do not stop paper", () => {
    let t = 0;
    const b = new BreakerBoard(() => t);
    evaluateBreakers(b, { ...healthy, recentTxFailures: [true, false, true, true], balanceMatches: false });
    expect(b.open().sort()).toEqual(["BALANCE_MISMATCH", "TX_FAILURE_SPIKE"]);
    t += 10 * AUTO_CLOSE_AFTER_MS;
    evaluateBreakers(b, healthy);
    expect(b.isOpen("TX_FAILURE_SPIKE")).toBe(true);
    expect(b.blocking("paper")).toEqual([]);
    expect(b.blocking("live").length).toBe(2);
    expect(b.reset("TX_FAILURE_SPIKE", "user")).toBe(true);
    expect(b.open()).toEqual(["BALANCE_MISMATCH"]);
  });

  it("unexpected slippage trips on the median of recent deviations; state survives restarts", () => {
    const b = new BreakerBoard(() => 0);
    evaluateBreakers(b, { ...healthy, slippageDeviationsBps: [2, 30, 40, 31, 1] });
    expect(b.isOpen("UNEXPECTED_SLIPPAGE")).toBe(true);
    const b2 = new BreakerBoard(() => 0);
    b2.restore(b.snapshot());
    expect(b2.isOpen("UNEXPECTED_SLIPPAGE")).toBe(true);
  });
});

describe("live levels", () => {
  const stats = (o: Partial<LevelTradeStats> = {}): LevelTradeStats => ({ netEur: [], failures: 0, attempts: 0, consecutiveFailures: 0, drawdownEur: 0, liveVsPaperBps: null, ...o });

  it("downgrades automatically and stops live at level 1", () => {
    expect(evaluateLiveLevel(3, stats({ consecutiveFailures: 3 }), DEFAULT_SETTINGS)).toMatchObject({ action: "downgrade", level: 2 });
    expect(evaluateLiveLevel(1, stats({ liveVsPaperBps: -20 }), DEFAULT_SETTINGS)).toMatchObject({ action: "stop_live" });
    expect(evaluateLiveLevel(2, stats({ netEur: Array(12).fill(-0.01) }), DEFAULT_SETTINGS).action).toBe("downgrade");
    expect(evaluateLiveLevel(2, stats({ netEur: [0.01, 0.02] }), DEFAULT_SETTINGS).action).toBe("keep");
  });

  it("level up is only ever eligible (never automatic) and needs significant evidence", () => {
    const good = Array.from({ length: 30 }, (_, i) => 0.01 + (i % 3) * 0.002);
    expect(levelUpEligibility(1, stats({ netEur: good, attempts: 30 }), DEFAULT_SETTINGS)).toMatchObject({ eligible: true, next: 2 });
    expect(levelUpEligibility(1, stats({ netEur: good.slice(0, 10), attempts: 10 }), DEFAULT_SETTINGS).eligible).toBe(false);
    expect(levelUpEligibility(4, stats({ netEur: good }), DEFAULT_SETTINGS).eligible).toBe(false);
  });
});
