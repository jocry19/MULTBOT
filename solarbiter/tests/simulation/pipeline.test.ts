/**
 * Simulation: the full decision pipeline on hundreds of seeded market situations —
 * screening → firm quotes + size ladder → NO NET EDGE = NO TRADE → risk gate → paper execution after
 * latency with re-quotes → learning. Invariants are checked on every single trade.
 */
import { describe, expect, it } from "vitest";
import { CandidateQueue, OpportunityEvaluator, screen, type FeeModel } from "@solarbiter/arbitrage";
import { DexRegistry } from "@solarbiter/dex";
import { LearningEngine } from "@solarbiter/learning-engine";
import { PaperExecutor, Portfolio, registryRequoter } from "@solarbiter/paper-engine";
import { RiskEngine, type RiskContext } from "@solarbiter/risk-engine";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, DEFAULT_SETTINGS, SOL_MINT, eurToLamports, lamportsToEur, mergeSettings, type TokenInfo } from "@solarbiter/shared";
import { DECIMALS, JUP, SimMarket } from "../helpers/simMarket.js";

const SOL_EUR = 120;
const token: TokenInfo = { mint: JUP, symbol: "JUP", name: "Jupiter", decimals: 6, program: "Tokenkeg", mintAuthority: null, freezeAuthority: null, allowlisted: false, denylisted: false, safe: true, safetyReasons: [] };
const fees = (viaJito: boolean): FeeModel => ({ computeUnits: () => 300_000, priorityFeeLamports: () => 10_000n, jitoTipLamports: () => 10_000n, viaJito: () => viaJito });

function riskCtx(p: Portfolio, settings = DEFAULT_SETTINGS, now = 0): RiskContext {
  return {
    now,
    mode: "paper",
    settings,
    botState: "PAPER",
    liveGate: "LIVE_LOCKED",
    liveModeEnabled: false,
    emergencyStop: false,
    blockingBreakers: [],
    solEur: SOL_EUR,
    balanceLamports: p.balanceLamports,
    capitalEur: lamportsToEur(p.balanceLamports, SOL_EUR),
    openTrades: p.openTrades,
    pnlTodayEur: p.pnlTodayEur(),
    consecutiveFailures: p.consecutiveFailures,
    lossStreak: p.lossStreak,
    lastTradeSizeEur: p.lastTradeSizeEur,
    lastTradeLost: p.lastTradeLost,
    drawdownEur: p.drawdownEur(),
    expectancyEur: p.expectancyEur(),
    token,
    liquidityDepthEur: null,
    viaJito: true,
  };
}

async function runScenario(seed: number, opts: { mispricingBps: number; driftBps: number; viaJito: boolean; settings?: typeof DEFAULT_SETTINGS }) {
  let t = 1_000_000;
  const now = () => t;
  const market = SimMarket.random(seed, opts.mispricingBps);
  const registry = new DexRegistry().register(market.adapter("raydium", now)).register(market.adapter("orca", now));
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const learning = new LearningEngine(() => settings, now);
  const evaluator = new OpportunityEvaluator(registry, fees(opts.viaJito), learning);
  const risk = new RiskEngine();
  const portfolio = new Portfolio("paper", eurToLamports(15, SOL_EUR), now);
  const exec = new PaperExecutor({
    risk,
    requote: registryRequoter(registry, (m) => DECIMALS[m], opts.viaJito),
    simulator: null,
    settings: () => settings,
    latencyMs: () => 900,
    viaJito: () => opts.viaJito,
    now,
    sleep: async (ms) => {
      t += ms;
      market.randomDrift(opts.driftBps);
    },
  });
  const { candidates } = screen(market.states(t), { minNetSpreadBps: settings.strategy.screenMinSpreadBps, direct: true, triangular: false, maxSwaps: 3, tradable: (m) => m === JUP, now: t });
  const queue = new CandidateQueue({ maxPerMinute: 10, cooldownMs: 30_000, improvementBps: 5, maxAgeMs: 60_000 }, now);
  queue.offer(candidates);
  const c = queue.next();
  if (!c) return { candidates: candidates.length, opportunity: null, trade: null, portfolio };
  const cap = risk.sizeCap(riskCtx(portfolio, settings, t));
  const { opportunity: o, verdict } = await evaluator.evaluate(c, { mode: "paper", settings, solEur: SOL_EUR, sizeCapEur: cap.capEur, strategyVersionId: "v1", rentLockedLamports: 0n, poolStateAgeMs: 0, volatilityBps: 0, decimals: (m) => DECIMALS[m], now });
  if (!verdict.trade) return { candidates: candidates.length, opportunity: o, trade: null, portfolio };
  const decision = risk.validate(o, riskCtx(portfolio, settings, t));
  if (!decision.allowed) return { candidates: candidates.length, opportunity: o, trade: null, portfolio, decision };
  const trade = await exec.execute(o, decision.approval, portfolio);
  return { candidates: candidates.length, opportunity: o, trade, portfolio, decision };
}

describe("simulation: full pipeline on seeded markets", () => {
  it("NO NET EDGE = NO TRADE and atomic losses are bounded — 300 scenarios", async () => {
    let executed = 0;
    let rejected = 0;
    let reverted = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const viaJito = seed % 3 !== 0;
      const r = await runScenario(seed, { mispricingBps: 150, driftBps: 40, viaJito });
      const o = r.opportunity;
      if (!o) continue;
      if (!r.trade) {
        rejected++;
        // every non-trade carries a reason
        if (o.status === "REJECTED") expect(o.rejectionReason).not.toBeNull();
        continue;
      }
      executed++;
      // a trade was only executed with a positive usable edge above the thresholds
      expect(o.expectedNetProfit > 0n).toBe(true);
      expect(o.expectedNetProfitEur).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.strategy.minNetProfitEur);
      expect(o.sizeEur).toBeLessThanOrEqual(DEFAULT_SETTINGS.capital.maxTradeEur);
      // atomic guard: worst case is the fees of a reverted RPC transaction; via Jito a revert costs nothing
      const fees = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee;
      if (r.trade.success === false) {
        reverted++;
        expect(r.trade.realizedNet).toBe(viaJito ? 0n : -fees);
      } else if (r.trade.success === true) {
        // a landed trade cleared the closing guard: never below the minimum profit
        expect(r.trade.realizedNet >= eurToLamports(DEFAULT_SETTINGS.strategy.minNetProfitEur, SOL_EUR) - 1n).toBe(true);
      }
      // paper balance moves by exactly the realised result
      expect(r.portfolio.balanceLamports).toBe(eurToLamports(15, SOL_EUR) + r.trade.realizedNet);
    }
    expect(executed).toBeGreaterThan(10);
    expect(rejected).toBeGreaterThan(10);
    expect(reverted).toBeGreaterThan(0);
  });

  it("a fairly priced market produces no trades at all (DO NOTHING)", async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = await runScenario(seed, { mispricingBps: 3, driftBps: 0, viaJito: true });
      expect(r.trade).toBeNull();
    }
  });

  it("thin liquidity: the size ladder shrinks the trade instead of taking the impact", async () => {
    const r = await runScenario(7, { mispricingBps: 150, driftBps: 0, viaJito: true });
    if (r.opportunity && r.opportunity.sizeLadder.length > 1) {
      const best = r.opportunity.sizeLadder.reduce((a, b) => (b.costs.usableEdgeLamports > a.costs.usableEdgeLamports ? b : a));
      expect(r.opportunity.sizeEur).toBe(best.sizeEur);
    }
  });

  it("daily loss limit stops trading for the day (risk can only shrink automatically)", async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { risk: { dailyLossLimitEur: 0.001 } });
    const p = new Portfolio("paper", eurToLamports(15, SOL_EUR), () => 0);
    p.close({ id: "x", mode: "paper", closedAt: 0, sizeEur: 1, netLamports: -10_000n, netEur: -0.0012, success: false });
    const risk = new RiskEngine();
    const { makeOpportunity } = await import("@solarbiter/shared/testing");
    const d = risk.validate(makeOpportunity(), riskCtx(p, settings));
    expect(d.codes).toContain("DAILY_LOSS_LIMIT");
  });
});
