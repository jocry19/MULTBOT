import { describe, expect, it } from "vitest";
import { RiskEngine, type RiskContext } from "@solarbiter/risk-engine";
import { DEFAULT_SETTINGS, solToLamports, type Quote } from "@solarbiter/shared";
import { TEST_TOKEN, makeOpportunity } from "@solarbiter/shared/testing";
import { PaperExecutor, type LegRequoter, type ShadowSimulator } from "./executor.js";
import { Portfolio } from "./portfolio.js";

const riskCtx = (portfolio: Portfolio): RiskContext => ({
  now: 1_000,
  mode: "paper",
  settings: DEFAULT_SETTINGS,
  botState: "PAPER",
  liveGate: "LIVE_LOCKED",
  liveModeEnabled: false,
  emergencyStop: false,
  blockingBreakers: [],
  solEur: 120,
  balanceLamports: portfolio.balanceLamports,
  capitalEur: portfolio.equityEur(120),
  openTrades: portfolio.openTrades,
  pnlTodayEur: portfolio.pnlTodayEur(),
  consecutiveFailures: portfolio.consecutiveFailures,
  lossStreak: portfolio.lossStreak,
  lastTradeSizeEur: portfolio.lastTradeSizeEur,
  lastTradeLost: portfolio.lastTradeLost,
  drawdownEur: portfolio.drawdownEur(),
  expectancyEur: null,
  token: { mint: TEST_TOKEN, symbol: "JUP", name: "", decimals: 6, program: "", mintAuthority: null, freezeAuthority: null, allowlisted: false, denylisted: false, safe: true, safetyReasons: [] },
  liquidityDepthEur: null,
  viaJito: true,
});

/** Market after the latency: each leg returns `factor` × its detection-time rate. */
const market = (factors: number[], calls: { leg: number; amount: bigint }[] = []): LegRequoter => {
  let i = 0;
  return async (leg: Quote, amount: bigint) => {
    const k = i++ % factors.length;
    calls.push({ leg: k, amount });
    const out = BigInt(Math.floor((Number(leg.outputAmount) * Number(amount) * (factors[k] as number)) / Number(leg.inputAmount)));
    return { ...leg, inputAmount: amount, outputAmount: out, timestamp: 2_000 };
  };
};

function setup(requote: LegRequoter, o: { viaJito?: boolean; simulator?: ShadowSimulator | null } = {}) {
  let t = 1_000;
  const risk = new RiskEngine();
  const portfolio = new Portfolio("paper", solToLamports(15 / 120), () => t);
  const slept: number[] = [];
  const exec = new PaperExecutor({
    risk,
    requote,
    simulator: o.simulator ?? null,
    settings: () => DEFAULT_SETTINGS,
    latencyMs: () => 900,
    viaJito: () => o.viaJito ?? true,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  const opp = makeOpportunity();
  const approval = risk.validate(opp, riskCtx(portfolio)).approval;
  return { exec, risk, portfolio, opp, approval, slept };
}

describe("PaperExecutor", () => {
  it("DETECTED → QUOTE → WAIT LATENCY → REQUOTE → CALCULATE → CLOSE with re-quoted amounts", async () => {
    const calls: { leg: number; amount: bigint }[] = [];
    const { exec, portfolio, opp, approval, slept } = setup(market([1, 1], calls));
    expect(approval).not.toBeNull();
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.stages.map((s) => s.stage)).toEqual(["DETECTED", "QUOTE", "WAIT_LATENCY", "REQUOTE", "CALCULATE", "CLOSE"]);
    expect(slept).toEqual([900]);
    expect(r.success).toBe(true);
    // leg 1 sells the size, the closing leg sells exactly what leg 1 delivered
    expect(calls[0]!.amount).toBe(opp.inputAmount);
    expect(calls[1]!.amount).toBe(opp.legs[0]!.outputAmount);
    expect(r.realizedNet).toBe(opp.legs[1]!.outputAmount - opp.inputAmount - 5_000n - opp.priorityFee - opp.jitoTip);
    expect(portfolio.balanceLamports).toBe(solToLamports(15 / 120) + r.realizedNet);
    expect(portfolio.openTrades).toBe(0);
    expect(r.predictionErrorBps).not.toBeNull();
  });

  it("an adverse move beyond the closing guard reverts: via Jito nothing is paid", async () => {
    const { exec, portfolio, opp, approval } = setup(market([1, 0.99]));
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.success).toBe(false);
    expect(r.failureReason).toMatch(/^REVERTED: leg 2/);
    expect(r.realizedNet).toBe(0n);
    expect(r.fees.paid).toBe(false);
    expect(portfolio.consecutiveFailures).toBe(1);
  });

  it("…while a reverting RPC transaction still pays base + priority fee", async () => {
    const { exec, portfolio, opp, approval } = setup(market([0.99, 1]), { viaJito: false });
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.failureReason).toMatch(/leg 1/);
    expect(r.realizedNet).toBe(-(5_000n + opp.priorityFee));
    expect(portfolio.balanceLamports).toBe(solToLamports(15 / 120) - 5_000n - opp.priorityFee);
  });

  it("small adverse move inside the guard: success with a smaller (real) profit", async () => {
    const { exec, portfolio, opp, approval } = setup(market([1, 0.9995]));
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.success).toBe(true);
    expect(r.slippageLamports! > 0n).toBe(true);
    expect(r.realizedNet < opp.legs[1]!.outputAmount - opp.inputAmount).toBe(true);
  });

  it("shadow mode: a failing simulation is never 'sent' and costs nothing", async () => {
    const simulator: ShadowSimulator = { simulate: async () => ({ ok: false, error: "custom program error: 0x1771", unitsConsumed: 90_000, logs: [] }) };
    const { exec, portfolio, opp, approval } = setup(market([1, 1]), { simulator });
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.shadow).toBe(true);
    expect(r.stages.map((s) => s.stage)).toContain("SIMULATE");
    expect(r.failureReason).toMatch(/SIMULATION_FAILED/);
    expect(r.realizedNet).toBe(0n);
  });

  it("unknown outcome when the re-quote is unavailable — excluded, not counted as profit or loss", async () => {
    const { exec, portfolio, opp, approval } = setup(async () => {
      throw new Error("429");
    });
    const r = await exec.execute(opp, approval, portfolio);
    expect(r.success).toBeNull();
    expect(portfolio.snapshot(120).trades).toBe(0);
    expect(portfolio.openTrades).toBe(0);
  });

  it("refuses to run without a valid risk approval", async () => {
    const { exec, portfolio, opp } = setup(market([1, 1]));
    await expect(exec.execute(opp, null, portfolio)).rejects.toThrow(/refused/);
    const live = new Portfolio("live", 1n);
    const s2 = setup(market([1, 1]));
    await expect(s2.exec.execute(s2.opp, s2.approval, live)).rejects.toThrow(/paper portfolio/);
  });
});

describe("Portfolio", () => {
  it("tracks daily PnL, drawdown, streaks and expectancy per mode", () => {
    let t = Date.UTC(2026, 0, 1, 10);
    const p = new Portfolio("paper", 1_000_000_000n, () => t);
    const trade = (net: number, success: boolean | null = true) => p.close({ id: "x", mode: "paper", closedAt: t, sizeEur: 2, netLamports: BigInt(net), netEur: net / 1e7, success });
    p.open();
    trade(100_000);
    p.open();
    trade(-300_000);
    p.open();
    trade(-100_000, false);
    expect(p.lossStreak).toBe(2);
    expect(p.consecutiveFailures).toBe(1);
    expect(p.lastTradeLost).toBe(true);
    expect(p.pnlTodayEur()).toBeCloseTo(-0.03, 9);
    expect(p.drawdownEur()).toBeCloseTo(0.04, 9);
    expect(p.expectancyEur()).toBeNull();
    t += 24 * 3600_000;
    expect(p.pnlTodayEur()).toBe(0);
  });
});
