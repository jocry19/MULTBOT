import { createHash, randomUUID } from "node:crypto";
import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  lamportsToEur,
  type BotState,
  type CircuitBreakerId,
  type LiveGateState,
  type Opportunity,
  type RejectionReason,
  type RiskDecision,
  type Settings,
  type TokenInfo,
  type TradeMode,
} from "@solarbiter/shared";
import { effectiveMaxTradeEur, type SizeCap } from "./sizing.js";

export interface RiskContext {
  now: number;
  mode: TradeMode;
  settings: Settings;
  botState: BotState;
  liveGate: LiveGateState;
  /** Hard environment switch (LIVE_MODE). false → live trading is impossible. */
  liveModeEnabled: boolean;
  emergencyStop: boolean;
  /** Breakers blocking this mode. */
  blockingBreakers: CircuitBreakerId[];
  solEur: number;
  /** Paper: virtual balance. Live: wallet SOL balance. */
  balanceLamports: bigint;
  capitalEur: number;
  openTrades: number;
  /** Realised PnL today in this mode (negative = loss). */
  pnlTodayEur: number;
  consecutiveFailures: number;
  lossStreak: number;
  lastTradeSizeEur: number | null;
  lastTradeLost: boolean;
  drawdownEur: number;
  expectancyEur: number | null;
  token: TokenInfo | undefined;
  liquidityDepthEur: number | null;
  /** Transaction is sent as a Jito bundle (a reverting bundle is not included → no fees). */
  viaJito: boolean;
}

/** Proof that validate() approved exactly this opportunity. Required by every execution path. */
export interface RiskApproval {
  readonly id: string;
  readonly opportunityId: string;
  readonly mode: TradeMode;
  readonly fingerprint: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Adverse move assumed while holding the token after a failed closing leg of a non-atomic route
 * (the position must be unwound at market). Non-atomic routes are disabled by default.
 */
export const NON_ATOMIC_INVENTORY_RISK_BPS = 500;

const TRADING_STATE: Record<TradeMode, BotState[]> = {
  paper: ["PAPER", "SHADOW", "LIVE"],
  live: ["LIVE"],
};

/** Fields an approval is bound to: changing any of them after validation voids the approval. */
function fingerprint(o: Opportunity): string {
  const parts = [
    o.id,
    o.mode,
    o.inputAmount.toString(),
    o.outputAmount.toString(),
    o.expectedNetProfit.toString(),
    o.priorityFee.toString(),
    o.jitoTip.toString(),
    o.tokenMint,
    o.route.join(">"),
    o.legs.map((l) => `${l.id}:${l.minOutputAmount}`).join(","),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * The single gate every trade (paper and live) must pass. There is no bypass: execution code only
 * accepts a RiskApproval issued here, bound to the exact opportunity and valid for the quote-age
 * window.
 */
export class RiskEngine {
  private readonly issued = new Map<string, RiskApproval>();

  /** Worst case loss of one attempt (EUR). */
  worstCaseLossEur(o: Opportunity, ctx: RiskContext): number {
    const fees = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee;
    let lamports: bigint;
    if (o.atomic) {
      // The closing leg's minimum output makes an unprofitable swap revert. Via Jito a reverting
      // bundle is not included (no cost); via RPC the fees are lost. The tip is counted conservatively.
      lamports = (ctx.viaJito ? 0n : fees) + o.jitoTip;
    } else {
      const s = ctx.settings.risk;
      lamports = (o.inputAmount * BigInt(s.maxSlippageBps + s.nonAtomicExtraBufferBps + NON_ATOMIC_INVENTORY_RISK_BPS)) / 10_000n + 2n * fees + o.jitoTip;
    }
    return lamportsToEur(lamports, ctx.solEur);
  }

  sizeCap(ctx: RiskContext): SizeCap {
    const r = ctx.settings.risk;
    const feeAllowance = lamportsToEur(BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE + r.maxPriorityFeeLamports + r.maxJitoTipLamports), ctx.solEur);
    return effectiveMaxTradeEur({
      feeAllowanceEur: feeAllowance,
      mode: ctx.mode,
      settings: ctx.settings,
      capitalEur: ctx.capitalEur,
      liquidityDepthEur: ctx.liquidityDepthEur,
      drawdownEur: ctx.drawdownEur,
      expectancyEur: ctx.expectancyEur,
      lossStreak: ctx.lossStreak,
      lastTradeSizeEur: ctx.lastTradeSizeEur,
      lastTradeLost: ctx.lastTradeLost,
    });
  }

  validate(o: Opportunity, ctx: RiskContext): RiskDecision & { approval: RiskApproval | null } {
    const s = ctx.settings;
    const codes: RejectionReason[] = [];
    const reasons: string[] = [];
    const checks: Record<string, boolean> = {};
    const check = (name: string, ok: boolean, code: RejectionReason, reason: string) => {
      checks[name] = ok;
      if (!ok) {
        if (!codes.includes(code)) codes.push(code);
        reasons.push(reason);
      }
    };

    // --- system state ---------------------------------------------------------------------------
    check("modeMatches", o.mode === ctx.mode, "RISK_LIMIT", `opportunity mode ${o.mode} ≠ engine mode ${ctx.mode}`);
    check("emergencyStop", !ctx.emergencyStop && !s.risk.emergencyStop, "BOT_NOT_TRADING", "EMERGENCY STOP active");
    check("botState", TRADING_STATE[ctx.mode].includes(ctx.botState), "BOT_NOT_TRADING", `bot state ${ctx.botState} does not allow ${ctx.mode} trades`);
    if (ctx.mode === "live") {
      check("liveEnv", ctx.liveModeEnabled, "BOT_NOT_TRADING", "LIVE_MODE is disabled in the environment");
      check("liveGate", ctx.liveGate === "LIVE_ENABLED", "BOT_NOT_TRADING", `live gate is ${ctx.liveGate} (manual enable required)`);
    }
    check("breakers", ctx.blockingBreakers.length === 0, "CIRCUIT_BREAKER", `circuit breaker open: ${ctx.blockingBreakers.join(", ")}`);

    // --- data quality ---------------------------------------------------------------------------
    check("quoteFresh", o.quoteAge <= s.strategy.maxQuoteAgeMs, "QUOTE_TOO_OLD", `quote age ${o.quoteAge} ms > ${s.strategy.maxQuoteAgeMs} ms`);
    check("legsPresent", o.legs.length >= 2 && o.legs.every((l) => l.kind === "firm"), "ROUTE_UNAVAILABLE", "decision requires firm quotes for every leg");
    check("token", ctx.token?.safe === true, "TOKEN_REJECTED", ctx.token ? `token unsafe: ${ctx.token.safetyReasons.join("; ")}` : "unknown token");

    // --- execution shape ------------------------------------------------------------------------
    check("atomic", o.atomic || !s.risk.requireAtomic, "NOT_ATOMIC", "route cannot be executed atomically");
    const maxLegSlippage = Math.max(0, ...o.legs.slice(0, -1).map((l) => l.slippageBps));
    check("slippage", maxLegSlippage <= s.risk.maxSlippageBps, "SLIPPAGE_TOO_HIGH", `leg slippage ${maxLegSlippage} bps > ${s.risk.maxSlippageBps} bps`);
    check("priceImpact", o.priceImpact * 10_000 <= s.risk.maxPriceImpactBps, "PRICE_IMPACT_TOO_HIGH", `price impact ${(o.priceImpact * 10_000).toFixed(1)} bps > ${s.risk.maxPriceImpactBps} bps`);
    check("priorityFee", o.priorityFee <= BigInt(s.risk.maxPriorityFeeLamports), "PRIORITY_FEE_TOO_HIGH", `priority fee ${o.priorityFee} > ${s.risk.maxPriorityFeeLamports} lamports`);
    check("jitoTip", o.jitoTip <= BigInt(s.risk.maxJitoTipLamports), "JITO_TOO_EXPENSIVE", `Jito tip ${o.jitoTip} > ${s.risk.maxJitoTipLamports} lamports`);

    // --- NO NET EDGE = NO TRADE -----------------------------------------------------------------
    check("netEdge", o.expectedNetProfit > 0n && o.expectedNetProfitEur >= s.strategy.minNetProfitEur, "NET_PROFIT_BELOW_THRESHOLD", `expected net ${o.expectedNetProfitEur.toFixed(4)} € below ${s.strategy.minNetProfitEur} €`);
    check("execProbability", o.executionProbability >= s.strategy.minExecutionProbability, "EXECUTION_PROBABILITY_TOO_LOW", `execution probability ${(o.executionProbability * 100).toFixed(0)} %`);

    // --- capital & limits -----------------------------------------------------------------------
    const cap = this.sizeCap(ctx);
    check("size", o.sizeEur <= cap.capEur + 1e-9, "RISK_LIMIT", `size ${o.sizeEur.toFixed(2)} € > cap ${cap.capEur.toFixed(2)} € (${cap.binding})`);
    check("concurrency", ctx.openTrades < s.capital.maxConcurrentTrades, "CONCURRENCY_LIMIT", `${ctx.openTrades} open trade(s), max ${s.capital.maxConcurrentTrades}`);
    const spend = o.inputAmount + BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee + o.jitoTip + (o.costs?.rentLockedLamports ?? 0n);
    const afterEur = lamportsToEur(ctx.balanceLamports - spend, ctx.solEur);
    check("reserve", afterEur >= s.capital.reserveCapitalEur, "WALLET_RESERVE", `balance after trade ${afterEur.toFixed(2)} € < reserve ${s.capital.reserveCapitalEur} €`);
    const worst = this.worstCaseLossEur(o, ctx);
    check("maxLossPerTrade", worst <= s.risk.maxLossPerTradeEur, "RISK_LIMIT", `worst-case loss ${worst.toFixed(3)} € > ${s.risk.maxLossPerTradeEur} €`);
    check("dailyLoss", -ctx.pnlTodayEur + worst <= s.risk.dailyLossLimitEur, "DAILY_LOSS_LIMIT", `today ${ctx.pnlTodayEur.toFixed(3)} € − worst case ${worst.toFixed(3)} € breaches the daily limit ${s.risk.dailyLossLimitEur} €`);
    check("consecutiveFailures", ctx.consecutiveFailures < s.risk.maxConsecutiveFailures, "RISK_LIMIT", `${ctx.consecutiveFailures} consecutive failures (max ${s.risk.maxConsecutiveFailures})`);

    const allowed = codes.length === 0;
    let approval: RiskApproval | null = null;
    if (allowed) {
      const remaining = Math.max(0, s.strategy.maxQuoteAgeMs - o.quoteAge);
      approval = Object.freeze({ id: randomUUID(), opportunityId: o.id, mode: o.mode, fingerprint: fingerprint(o), issuedAt: ctx.now, expiresAt: ctx.now + remaining });
      this.issued.set(approval.id, approval);
      if (this.issued.size > 1_000) {
        for (const [k, a] of this.issued) if (a.expiresAt < ctx.now) this.issued.delete(k);
      }
    }
    return { allowed, codes, reasons, checks, approval };
  }

  /**
   * Execution-side check: the approval must have been issued by this engine, be unexpired and
   * match the opportunity exactly (amounts, fees, minimum outputs). Consumed on use.
   */
  consumeApproval(approval: RiskApproval | null | undefined, o: Opportunity, now: number): { ok: boolean; reason: string | null } {
    if (!approval) return { ok: false, reason: "no risk approval" };
    const known = this.issued.get(approval.id);
    if (!known || known !== approval) return { ok: false, reason: "approval not issued by this risk engine" };
    this.issued.delete(approval.id);
    if (now > known.expiresAt) return { ok: false, reason: "approval expired (quote too old)" };
    if (known.opportunityId !== o.id || known.mode !== o.mode) return { ok: false, reason: "approval belongs to another opportunity" };
    if (known.fingerprint !== fingerprint(o)) return { ok: false, reason: "opportunity changed after approval" };
    return { ok: true, reason: null };
  }
}
