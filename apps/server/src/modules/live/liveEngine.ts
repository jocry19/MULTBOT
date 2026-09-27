import { randomUUID } from "node:crypto";
import type { ComponentStatus, EngineState, ExitReason, LiveTradingState, ReconciliationState, Settings, StrategySpec } from "@multbot/shared";
import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import type { Clock } from "../../core/clock.js";
import { idempotencyKey } from "../../core/hash.js";
import { metrics } from "../../core/metrics.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { BusEvents, DecisionPoint, PriceUpdate } from "../../app/busEvents.js";
import type { ActivityLog } from "../activity/activityLog.js";
import type { ExecutionEngine } from "../execution/executionEngine.js";
import { LiveMarketView } from "../execution/liveView.js";
import { estimateRoundTripCosts } from "../execution/simulator.js";
import { compactFeatures } from "../features/featureEngine.js";
import type { Ledger } from "../ledger/ledger.js";
import type { MarketState } from "../market/marketState.js";
import { executionParamsFromSettings } from "../research/labeler.js";
import { checkEntry, checkExit, type RiskSnapshot } from "../risk/riskEngine.js";
import type { RpcManager } from "../solana/rpcManager.js";
import { matchSpec } from "../strategy/evaluate.js";
import type { StrategyService, VersionRow } from "../strategy/strategyService.js";
import type { StateStore } from "../system/stateStore.js";
import type { TaxLedger } from "../tax/taxLedger.js";
import { featureExit, priceExit, updateExtremes, type HeldPosition } from "../trading/exitRules.js";
import type { WalletService } from "../wallet/walletService.js";

/**
 * Real-money trading. LOCKED by default; only a user action unlocks it, and only strategies the
 * user explicitly enabled (LIVE_ENABLED) can trade. Every entry passes the risk engine; every
 * transaction goes through the ExecutionEngine (integrity checks + simulation + confirmation).
 * Every trade gets strategy / version / signal / event ids, ledger entries and tax records.
 */

interface LivePosition extends HeldPosition {
  id: string;
  strategyId: string;
  versionId: string;
  spec: StrategySpec;
  mint: string;
  tokenRaw: bigint;
  decimals: number;
  costSol: number;
  closing: boolean;
}

export const LIVE_STATE_KEY = "live_trading";
export const BOT_STATE_KEY = "bot";
export const RECON_STATE_KEY = "reconciliation";

export class LiveEngine extends BaseModule {
  private active: { strategyId: string; status: string; liveEnabled: boolean; version: VersionRow }[] = [];
  private readonly positions = new Map<string, LivePosition>();
  private readonly view: LiveMarketView;
  private readonly entering = new Set<string>();
  private emergencyHandled = false;

  constructor(
    private readonly db: Database,
    private readonly bus: TypedBus<BusEvents>,
    private readonly market: MarketState,
    private readonly strategies: StrategyService,
    private readonly store: StateStore,
    private readonly wallet: WalletService,
    private readonly execution: ExecutionEngine,
    private readonly ledger: Ledger,
    private readonly tax: TaxLedger,
    private readonly rpc: RpcManager,
    private readonly activity: ActivityLog,
    private readonly clock: Clock,
    log: Logger,
    private readonly lastStreamEventAt: () => number | null,
  ) {
    super("live", log);
    this.view = new LiveMarketView(market);
    bus.on("market.decision", (dp) => void this.onDecision(dp).catch((err) => this.log.error({ err }, "live decision failed")));
    bus.on("market.price", (u) => this.onPrice(u));
    this.every("exits", 1_000, async () => this.checkTimeExits());
    this.every("reload", 60_000, () => this.reload());
    this.every("emergency", 1_000, async () => this.watchEmergency());
  }

  get liveState(): LiveTradingState {
    return this.store.getState<{ state: LiveTradingState }>(LIVE_STATE_KEY, { state: "LOCKED" }).state;
  }

  get botRunning(): boolean {
    return this.store.getState<{ running: boolean }>(BOT_STATE_KEY, { running: true }).running;
  }

  get reconciliation(): ReconciliationState {
    return this.store.getState<{ state: ReconciliationState }>(RECON_STATE_KEY, { state: "OK" }).state;
  }

  get engineState(): EngineState {
    if (!this.botRunning) return "STOPPED";
    if (this.liveState === "LOCKED") return "PAUSED";
    return "RUNNING";
  }

  get openPositions(): LivePosition[] {
    return [...this.positions.values()];
  }

  override componentStatus(): ComponentStatus {
    if (!this.wallet.signer) return "DISABLED";
    return this.liveState === "ACTIVE" ? "CONNECTED" : "DISABLED";
  }

  override healthDetail(): string {
    return `live=${this.liveState} bot=${this.botRunning ? "running" : "stopped"} strategies=${this.active.length} open=${this.positions.size} recon=${this.reconciliation}`;
  }

  protected override async onStart(): Promise<void> {
    await this.reload();
    await this.loadPositions();
  }

  async reload(): Promise<void> {
    const rows = await this.strategies.activeForLive();
    this.active = rows.map((r) => ({ strategyId: r.strategy.id, status: r.strategy.status, liveEnabled: r.strategy.live_enabled, version: r.version }));
  }

  async loadPositions(): Promise<void> {
    const rows = await this.db.many<{
      id: string;
      strategy_id: string;
      strategy_version_id: string;
      mint: string;
      token_qty: string | null;
      token_decimals: number | null;
      entry_price: number | null;
      opened_at: Date | null;
      gross_entry_sol: number | null;
      actual: { entrySpot?: number; entryLiquidity?: number; peak?: number; trough?: number } | null;
      spec: StrategySpec;
    }>(`SELECT t.*, v.spec FROM live_trades t JOIN strategy_versions v ON v.id = t.strategy_version_id WHERE t.status IN ('OPEN', 'CLOSING')`);
    this.positions.clear();
    for (const r of rows) {
      if (!r.token_qty || r.entry_price === null || !r.opened_at) continue;
      const spot = r.actual?.entrySpot ?? r.entry_price;
      this.positions.set(r.id, {
        id: r.id,
        strategyId: r.strategy_id,
        versionId: r.strategy_version_id,
        spec: r.spec,
        mint: r.mint,
        tokenRaw: BigInt(r.token_qty),
        decimals: r.token_decimals ?? 6,
        costSol: r.gross_entry_sol ?? 0,
        closing: false,
        entryPrice: r.entry_price,
        entrySpot: spot,
        entryLiquidity: r.actual?.entryLiquidity ?? 0,
        openedAt: r.opened_at.getTime(),
        peak: r.actual?.peak ?? spot,
        trough: r.actual?.trough ?? spot,
      });
      this.market.pinned.add(r.mint);
    }
  }

  private async snapshot(strategy: { strategyId: string; status: string; liveEnabled: boolean; version: VersionRow }, mint: string): Promise<RiskSnapshot> {
    const today = new Date(this.clock.now());
    today.setUTCHours(0, 0, 0, 0);
    const realized = await this.db.one<{ s: number | null }>("SELECT sum(net_pnl_sol) AS s FROM live_trades WHERE closed_at >= $1", [today]);
    let unrealized = 0;
    for (const p of this.positions.values()) {
      const price = this.market.tokens.get(p.mint)?.lastPrice ?? p.entrySpot;
      unrealized += (Number(p.tokenRaw) / 10 ** p.decimals) * price - p.costSol;
    }
    const token = this.market.tokens.get(mint);
    return {
      now: this.clock.now(),
      settings: this.store.get(),
      liveState: this.liveState,
      botRunning: this.botRunning,
      reconciliation: this.reconciliation,
      walletLamports: this.wallet.lamports,
      openPositions: [...this.positions.values()].map((p) => ({ mint: p.mint, costSol: p.costSol })),
      realizedTodaySol: realized?.s ?? 0,
      unrealizedSol: unrealized,
      tokenDataAt: token?.lastTradeAt && this.lastStreamEventAt() ? Math.max(token.lastTradeAt, 0) : null,
      rpcHealthy: this.rpc.componentStatus() !== "DISCONNECTED",
      strategy: { id: strategy.strategyId, versionId: strategy.version.id, status: strategy.status, liveEnabled: strategy.liveEnabled },
    };
  }

  async onDecision(dp: DecisionPoint): Promise<void> {
    for (const p of this.positions.values()) {
      if (p.mint !== dp.mint || p.closing) continue;
      const reason = featureExit(p.spec, p, dp.features);
      if (reason) void this.close(p, reason, false);
    }
    if (this.liveState !== "ACTIVE" || !this.wallet.signer || this.active.length === 0) return;
    const token = this.market.tokens.get(dp.mint);
    if (!token) return;
    const s = this.store.get();
    for (const a of this.active) {
      const m = matchSpec(a.version.spec, dp.features, token.venue, token.ageAt(dp.ts));
      if (!m.matched) continue;
      const key = `${a.version.id}|${dp.mint}`;
      if (this.entering.has(key)) continue;
      const state = this.view.stateAt(dp.mint);
      const exec = executionParamsFromSettings(s);
      const est = state ? estimateRoundTripCosts(state, s.trading.positionSizeSol, exec) : null;
      const snap = await this.snapshot(a, dp.mint);
      snap.tokenDataAt = token.lastTradeAt || null;
      const decision = checkEntry(snap, {
        mint: dp.mint,
        positionSizeSol: s.trading.positionSizeSol,
        expectedPriceImpactBps: est ? est.entryImpact * 10_000 : null,
        estimatedFeesSol: s.trading.maxPriorityFeeSol * 2 + 0.003,
      });
      const idem = idempotencyKey("live", a.version.id, dp.mint, dp.ts);
      const expected = {
        breakEvenMove: est?.breakEvenMove ?? null,
        estimatedCostSol: est?.totalCostSol ?? null,
        expectedSlippageSol: est ? est.entryImpact * s.trading.positionSizeSol : null,
        risk: decision.checks,
        trigger: dp.trigger,
        dataAgeSec: state ? (this.clock.now() - state.ts) / 1000 : null,
      };
      const signalId = randomUUID();
      const ins = await this.db.query(
        `INSERT INTO signals (id, mode, idempotency_key, strategy_id, strategy_version_id, mint, event_id, ts, decision, reasons, expected, features)
         VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (idempotency_key) DO NOTHING`,
        [signalId, idem, a.strategyId, a.version.id, dp.mint, dp.eventId, new Date(dp.ts), decision.allowed ? "ENTER" : "NO_TRADE", JSON.stringify({ trigger: dp.trigger, riskReasons: decision.reasons, conditions: m.details }), JSON.stringify(expected), JSON.stringify(compactFeatures(dp.features))],
      );
      if ((ins.rowCount ?? 0) === 0) continue; // duplicate decision point
      metrics.signals.inc({ mode: "live", decision: decision.allowed ? "enter" : "no_trade" });
      if (!decision.allowed) {
        this.activity.info("live", `${a.strategyId} matched ${token.symbol ?? dp.mint.slice(0, 6)} → NO TRADE (${decision.reasons.slice(0, 2).join("; ")})`, { mint: dp.mint });
        continue;
      }
      this.entering.add(key);
      void this.enter(a, dp, signalId, idem, expected).finally(() => this.entering.delete(key));
    }
  }

  private async enter(a: { strategyId: string; version: VersionRow }, dp: DecisionPoint, signalId: string, idem: string, expected: Record<string, unknown>): Promise<void> {
    const s = this.store.get();
    const tradeId = randomUUID();
    const wallet = this.wallet.address as string;
    const token = this.market.tokens.get(dp.mint);
    await this.db.query(
      `INSERT INTO live_trades (id, idempotency_key, signal_id, strategy_id, strategy_version_id, event_id, wallet, mint, status, decision_ts,
         position_size_sol, expected_entry_price, features, expected, regime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPENING', $9, $10, $11, $12, $13, $14)`,
      [tradeId, idem, signalId, a.strategyId, a.version.id, dp.eventId, wallet, dp.mint, new Date(dp.ts), s.trading.positionSizeSol, token?.lastPrice ?? null, JSON.stringify(compactFeatures(dp.features)), JSON.stringify(expected), dp.regime ? JSON.stringify({ label: dp.regime.label }) : null],
    );
    this.activity.info("live", `LIVE entry ${a.strategyId} ${token?.symbol ?? dp.mint.slice(0, 6)}: executing ${s.trading.positionSizeSol} SOL buy`, { tradeId });
    const r = await this.execution.execute({
      idempotencyKey: idempotencyKey("live-buy", tradeId),
      liveTradeId: tradeId,
      kind: "buy",
      mint: dp.mint,
      amount: BigInt(Math.round(s.trading.positionSizeSol * 1e9)),
      maxSlippageBps: a.version.spec.entry.maxSlippageBps ?? s.trading.maxSlippageBps,
    });
    const decimals = token?.decimals ?? 6;
    if (r.status === "CONFIRMED" && r.tokenDeltaRaw && r.tokenDeltaRaw > 0n && r.solDeltaLamports !== null) {
      const spentSol = -r.solDeltaLamports / 1e9;
      const tokens = Number(r.tokenDeltaRaw) / 10 ** decimals;
      const priority = (r.costEstimate?.priorityFeeLamports ?? 0) / 1e9;
      const network = Math.max(0, (r.feeLamports ?? 5000) / 1e9 - priority);
      const rent = (r.costEstimate?.rentLamports ?? 0) / 1e9;
      const swapSol = spentSol - priority - network - rent;
      const spot = this.market.tokens.get(dp.mint)?.lastPrice ?? swapSol / tokens;
      const expectedTokens = r.quote ? Number(r.quote.outAmount) : Number(r.tokenDeltaRaw);
      const slippageSol = expectedTokens > 0 ? Math.max(0, (1 - Number(r.tokenDeltaRaw) / expectedTokens) * swapSol) : 0;
      const pos: LivePosition = {
        id: tradeId,
        strategyId: a.strategyId,
        versionId: a.version.id,
        spec: a.version.spec,
        mint: dp.mint,
        tokenRaw: r.tokenDeltaRaw,
        decimals,
        costSol: spentSol,
        closing: false,
        entryPrice: spentSol / tokens,
        entrySpot: spot,
        entryLiquidity: this.market.tokens.get(dp.mint)?.liquiditySol ?? 0,
        openedAt: this.clock.now(),
        peak: spot,
        trough: spot,
      };
      this.positions.set(tradeId, pos);
      this.market.pinned.add(dp.mint);
      await this.db.query(
        `UPDATE live_trades SET status = 'OPEN', opened_at = now(), token_qty = $2, token_decimals = $3, entry_price = $4, gross_entry_sol = $5,
           entry_slippage_sol = $6, entry_fees_sol = $7, entry_rent_sol = $8, priority_fees_sol = $9, network_fees_sol = $10, entry_signature = $11,
           actual = $12 WHERE id = $1`,
        [tradeId, r.tokenDeltaRaw.toString(), decimals, pos.entryPrice, swapSol, slippageSol, 0, rent, priority, network, r.signature, JSON.stringify({ entrySpot: spot, entryLiquidity: pos.entryLiquidity, orderId: r.orderId })],
      );
      await this.ledger.append(
        "TRADE_OPEN",
        {
          tradeId,
          timestamp: new Date(this.clock.now()).toISOString(),
          signature: r.signature,
          wallet,
          token: token?.symbol ?? null,
          mint: dp.mint,
          strategyId: a.strategyId,
          strategyVersion: a.version.id,
          signalId,
          eventId: dp.eventId,
          side: "entry",
          quantityRaw: r.tokenDeltaRaw.toString(),
          solValue: spentSol,
          feesSol: network,
          priorityFeeSol: priority,
          slippageSol,
          rentSol: rent,
          executionPrice: pos.entryPrice,
          expectedPrice: r.quote && Number(r.quote.outAmount) > 0 ? swapSol / (Number(r.quote.outAmount) / 10 ** decimals) : null,
          realizedPrice: pos.entryPrice,
          grossPnlSol: null,
          netPnlSol: null,
        },
        tradeId,
        r.signature,
      );
      await this.tax.recordBuy({ ts: new Date(), mint: dp.mint, tokens, solSpent: spentSol, feesSol: priority + network, signature: r.signature, tradeId });
      this.activity.success("live", `LIVE position opened: ${token?.symbol ?? dp.mint.slice(0, 6)} ${tokens.toFixed(0)} tokens for ${spentSol.toFixed(5)} SOL`, { tradeId, signature: r.signature });
      void this.wallet.refresh();
    } else if (r.status === "SENT") {
      this.activity.warn("live", `LIVE entry ${tradeId.slice(0, 8)} pending confirmation — will be reconciled`, { tradeId });
    } else {
      const burnt = r.solDeltaLamports !== null ? -r.solDeltaLamports / 1e9 : 0;
      await this.db.query("UPDATE live_trades SET status = 'FAILED', failed_reason = $2, net_pnl_sol = $3, gross_pnl_sol = 0, closed_at = now(), entry_signature = $4 WHERE id = $1", [
        tradeId,
        r.error ?? r.status,
        -burnt,
        r.signature,
      ]);
      await this.ledger.append("TRADE_FAILED", { tradeId, strategyId: a.strategyId, strategyVersion: a.version.id, signalId, mint: dp.mint, status: r.status, error: r.error, feesSol: burnt }, tradeId, r.signature);
      this.activity.warn("live", `LIVE entry not executed (${r.status}): ${r.error ?? ""}`, { tradeId });
    }
    this.bus.emit("invalidate", ["live", "wallet"]);
  }

  private onPrice(u: PriceUpdate): void {
    for (const p of this.positions.values()) {
      if (p.mint !== u.mint || p.closing) continue;
      updateExtremes(p, u.priceSol);
      const reason = priceExit(p.spec, p, u.priceSol, this.clock.now());
      if (reason) void this.close(p, reason, false);
    }
  }

  private checkTimeExits(): void {
    for (const p of this.positions.values()) {
      if (p.closing) continue;
      const price = this.market.tokens.get(p.mint)?.lastPrice ?? p.entrySpot;
      const reason = priceExit(p.spec, p, price, this.clock.now());
      if (reason) void this.close(p, reason, false);
    }
  }

  private async watchEmergency(): Promise<void> {
    const s = this.store.get();
    if (!s.risk.emergencyStop) {
      this.emergencyHandled = false;
      return;
    }
    if (this.emergencyHandled) return;
    this.emergencyHandled = true;
    this.activity.error("risk", `EMERGENCY STOP active — no new trades${s.risk.emergencyStopClosePositions ? ", closing all positions" : ", open positions kept"}`);
    if (s.risk.emergencyStopClosePositions) await this.closeAll("EMERGENCY_STOP");
  }

  async closeAll(reason: ExitReason = "MANUAL"): Promise<number> {
    const list = [...this.positions.values()].filter((p) => !p.closing);
    await Promise.all(list.map((p) => this.close(p, reason, true)));
    return list.length;
  }

  async closeById(id: string): Promise<boolean> {
    const p = this.positions.get(id);
    if (!p || p.closing) return false;
    await this.close(p, "MANUAL", true);
    return true;
  }

  async close(p: LivePosition, reason: ExitReason, manual: boolean): Promise<void> {
    if (p.closing) return;
    const s = this.store.get();
    const exitCheck = checkExit({ settings: s, rpcHealthy: this.rpc.componentStatus() !== "DISCONNECTED" }, manual || reason === "EMERGENCY_STOP");
    if (!exitCheck.allowed) {
      this.log.debug({ trade: p.id, reasons: exitCheck.reasons }, "exit blocked");
      return;
    }
    p.closing = true;
    await this.db.query("UPDATE live_trades SET status = 'CLOSING', exit_reason = $2 WHERE id = $1", [p.id, reason]);
    const emergency = reason === "EMERGENCY_STOP" || manual;
    const slippage = Math.min(5000, emergency ? s.trading.maxSlippageBps * 2 : s.trading.maxSlippageBps);
    // sell what the wallet actually holds of this mint (never more than this position)
    const held = this.wallet.holdings.get(p.mint)?.raw;
    const amount = held !== undefined && held < p.tokenRaw ? held : p.tokenRaw;
    const r = await this.execution.execute({
      idempotencyKey: idempotencyKey("live-sell", p.id, Math.floor(this.clock.now() / 30_000)),
      liveTradeId: p.id,
      kind: "sell",
      mint: p.mint,
      amount,
      maxSlippageBps: slippage,
    });
    if (r.status !== "CONFIRMED" || r.solDeltaLamports === null) {
      p.closing = false;
      await this.db.query("UPDATE live_trades SET status = 'OPEN' WHERE id = $1", [p.id]);
      this.activity.warn("live", `LIVE exit attempt failed (${r.status}): ${r.error ?? ""} — will retry`, { tradeId: p.id });
      return;
    }
    // refund the token account rent when fully sold
    let rentRefund = 0;
    const soldAll = (r.tokenDeltaRaw ?? 0n) + p.tokenRaw <= 0n || amount === p.tokenRaw;
    if (soldAll) {
      const c = await this.execution.execute({ idempotencyKey: idempotencyKey("live-close-ata", p.id), liveTradeId: p.id, kind: "close", mint: p.mint, amount: 0n, maxSlippageBps: 0 });
      if (c.status === "CONFIRMED" && c.solDeltaLamports !== null) rentRefund = c.solDeltaLamports / 1e9;
    }
    const received = r.solDeltaLamports / 1e9;
    const priority = (r.costEstimate?.priorityFeeLamports ?? 0) / 1e9;
    const network = Math.max(0, (r.feeLamports ?? 5000) / 1e9 - priority);
    const grossExit = received + priority + network;
    const net = received + rentRefund - p.costSol;
    const spot = this.market.tokens.get(p.mint)?.lastPrice ?? 0;
    const row = await this.db.one<{ priority_fees_sol: number; network_fees_sol: number; entry_slippage_sol: number; entry_rent_sol: number }>(
      "SELECT priority_fees_sol, network_fees_sol, entry_slippage_sol, entry_rent_sol FROM live_trades WHERE id = $1",
      [p.id],
    );
    const tokens = Number(p.tokenRaw) / 10 ** p.decimals;
    const expectedSol = r.quote ? Number(r.quote.outAmount) / 1e9 : grossExit;
    const exitSlippage = Math.max(0, expectedSol - grossExit);
    const totalCosts = (row?.priority_fees_sol ?? 0) + priority + (row?.network_fees_sol ?? 0) + network + (row?.entry_slippage_sol ?? 0) + exitSlippage + (row?.entry_rent_sol ?? 0) - rentRefund;
    await this.db.query(
      `UPDATE live_trades SET status = 'CLOSED', closed_at = now(), exit_price = $2, gross_exit_sol = $3, exit_slippage_sol = $4, exit_fees_sol = 0,
         exit_rent_refund_sol = $5, priority_fees_sol = priority_fees_sol + $6, network_fees_sol = network_fees_sol + $7,
         gross_pnl_sol = $8, net_pnl_sol = $9, net_return = $10, max_runup = $11, max_drawdown = $12, exit_signature = $13, exit_reason = $14,
         actual = COALESCE(actual, '{}'::jsonb) || $15::jsonb WHERE id = $1`,
      [
        p.id,
        tokens > 0 ? received / tokens : 0,
        grossExit,
        exitSlippage,
        rentRefund,
        priority,
        network,
        net + totalCosts,
        net,
        p.costSol > 0 ? net / p.costSol : 0,
        p.peak / p.entrySpot - 1,
        p.trough / p.entrySpot - 1,
        r.signature,
        reason,
        JSON.stringify({ netReturn: p.costSol > 0 ? net / p.costSol : 0, marketMove: spot > 0 ? spot / p.entrySpot - 1 : null, exitOrderId: r.orderId }),
      ],
    );
    await this.ledger.append(
      "TRADE_CLOSE",
      {
        tradeId: p.id,
        timestamp: new Date(this.clock.now()).toISOString(),
        signature: r.signature,
        wallet: this.wallet.address,
        mint: p.mint,
        strategyId: p.strategyId,
        strategyVersion: p.versionId,
        side: "exit",
        exitReason: reason,
        quantityRaw: amount.toString(),
        solValue: received,
        feesSol: network,
        priorityFeeSol: priority,
        slippageSol: exitSlippage,
        rentSol: -rentRefund,
        executionPrice: tokens > 0 ? received / tokens : null,
        expectedPrice: tokens > 0 ? expectedSol / tokens : null,
        realizedPrice: tokens > 0 ? received / tokens : null,
        grossPnlSol: net + totalCosts,
        netPnlSol: net,
      },
      p.id,
      r.signature,
    );
    await this.tax.recordSell({ ts: new Date(), mint: p.mint, tokens, solReceived: received + rentRefund, feesSol: priority + network, signature: r.signature, tradeId: p.id });
    this.positions.delete(p.id);
    if (![...this.positions.values()].some((x) => x.mint === p.mint)) this.market.pinned.delete(p.mint);
    this.activity.add(net >= 0 ? "success" : "info", "live", `LIVE position closed (${reason}): net ${net >= 0 ? "+" : ""}${net.toFixed(5)} SOL`, { tradeId: p.id, signature: r.signature });
    void this.wallet.refresh();
    this.bus.emit("invalidate", ["live", "wallet"]);
  }
}
