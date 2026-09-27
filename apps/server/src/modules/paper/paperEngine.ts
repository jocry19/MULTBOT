import { randomUUID } from "node:crypto";
import type { ComponentStatus, ExitReason, Settings, StrategySpec } from "@multbot/shared";
import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import type { Clock } from "../../core/clock.js";
import { idempotencyKey } from "../../core/hash.js";
import { metrics } from "../../core/metrics.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { BusEvents, DecisionPoint, PriceUpdate } from "../../app/busEvents.js";
import type { ActivityLog } from "../activity/activityLog.js";
import { LiveMarketView } from "../execution/liveView.js";
import { estimateRoundTripCosts, simulateEntry, simulateExit, tradeResult, type EntryFill } from "../execution/simulator.js";
import { compactFeatures } from "../features/featureEngine.js";
import type { MarketState } from "../market/marketState.js";
import { executionParamsFromSettings } from "../research/labeler.js";
import { hashSeed, seededRandom } from "../stats/stats.js";
import { matchSpec } from "../strategy/evaluate.js";
import type { StrategyService, VersionRow } from "../strategy/strategyService.js";
import { featureExit, priceExit, updateExtremes, type HeldPosition } from "../trading/exitRules.js";

/**
 * Paper trading on REAL live market data (never simulated prices).
 *
 * Every active strategy version receives the same decision points as research used. Entries and
 * exits are filled after the real execution delay against the then-current on-chain state with the
 * full cost model; random transaction failures are simulated deterministically per trade.
 * Paper capital, P&L and positions are completely separate from the real wallet.
 */

interface ActiveVersion {
  strategyId: string;
  status: string;
  version: VersionRow;
  expectedNetReturn: number | null;
  goodRegimes: Set<string> | null;
}

interface PaperPosition extends HeldPosition {
  id: string;
  strategyId: string;
  versionId: string;
  spec: StrategySpec;
  mint: string;
  entry: EntryFill;
  closing: boolean;
}

export class PaperEngine extends BaseModule {
  private active: ActiveVersion[] = [];
  private readonly positions = new Map<string, PaperPosition>();
  private readonly lastEntry = new Map<string, number>();
  private readonly view: LiveMarketView;
  opened = 0;
  closed = 0;

  constructor(
    private readonly db: Database,
    private readonly bus: TypedBus<BusEvents>,
    private readonly market: MarketState,
    private readonly strategies: StrategyService,
    private readonly settings: () => Settings,
    private readonly activity: ActivityLog,
    private readonly clock: Clock,
    log: Logger,
  ) {
    super("paper", log);
    this.view = new LiveMarketView(market);
    bus.on("market.decision", (dp) => void this.onDecision(dp).catch((err) => this.log.error({ err }, "paper decision failed")));
    bus.on("market.price", (u) => this.onPrice(u));
    this.every("time-exits", 1_000, async () => this.checkTimeExits());
    this.every("reload", 5 * 60_000, () => this.reload());
  }

  protected override async onStart(): Promise<void> {
    await this.reload();
    await this.recoverOpenPositions();
  }

  override componentStatus(): ComponentStatus {
    if (this.state !== "RUNNING") return "DISCONNECTED";
    return this.settings().trading.paperTradingEnabled ? "CONNECTED" : "DISABLED";
  }

  override healthDetail(): string {
    return `strategies=${this.active.length} open=${this.positions.size} opened=${this.opened} closed=${this.closed}`;
  }

  get openPositions(): number {
    return this.positions.size;
  }

  /** Reload active strategy versions (called on strategy changes). */
  async reload(): Promise<void> {
    const rows = await this.strategies.activeForPaper();
    const next: ActiveVersion[] = [];
    for (const { strategy, version } of rows) {
      const discovery = await this.strategies.latestResult(version.id, "discovery");
      const val = (discovery?.validation as { mean?: number } | undefined)?.mean;
      const hold = (discovery?.holdout as { mean?: number } | undefined)?.mean;
      const regimes = (discovery?.regimes as { label: string; n: number; mean: number }[] | undefined) ?? null;
      next.push({
        strategyId: strategy.id,
        status: strategy.status,
        version,
        expectedNetReturn: hold ?? val ?? null,
        goodRegimes: regimes ? new Set(regimes.filter((r) => r.n >= 10 && r.mean > 0).map((r) => r.label)) : null,
      });
    }
    this.active = next;
  }

  private async recoverOpenPositions(): Promise<void> {
    const rows = await this.db.many<{
      id: string;
      strategy_id: string;
      strategy_version_id: string;
      mint: string;
      opened_at: Date;
      decision_ts: Date;
      entry_price: number;
      token_qty: string;
      position_size_sol: number;
      gross_entry_sol: number;
      entry_fees_sol: number;
      entry_slippage_sol: number;
      entry_rent_sol: number;
      priority_fees_sol: number;
      network_fees_sol: number;
      mev_impact_sol: number;
      actual: { entrySpot?: number; entryLiquidity?: number; peak?: number; trough?: number; venue?: string; decimals?: number } | null;
      spec: StrategySpec;
    }>(
      `SELECT p.*, v.spec FROM paper_trades p JOIN strategy_versions v ON v.id = p.strategy_version_id WHERE p.status = 'OPEN'`,
    );
    for (const r of rows) {
      const tokens = Number(r.token_qty) / 10 ** (r.actual?.decimals ?? 6);
      const entrySpot = r.actual?.entrySpot ?? r.entry_price;
      const entry: EntryFill = {
        ok: true,
        mint: r.mint,
        decisionTs: r.decision_ts.getTime(),
        execTs: r.opened_at.getTime(),
        venue: (r.actual?.venue as "pump_curve" | "pump_amm") ?? "pump_curve",
        budgetSol: r.position_size_sol,
        swapSol: r.gross_entry_sol,
        tokens,
        tokensRaw: BigInt(r.token_qty),
        spotPrice: entrySpot,
        effectivePrice: r.entry_price,
        dexFeeSol: r.entry_fees_sol,
        slippageSol: r.entry_slippage_sol,
        mevSol: r.mev_impact_sol / 2,
        priorityFeeSol: r.priority_fees_sol,
        networkFeeSol: r.network_fees_sol,
        rentSol: r.entry_rent_sol,
        capped: false,
      };
      this.positions.set(r.id, {
        id: r.id,
        strategyId: r.strategy_id,
        versionId: r.strategy_version_id,
        spec: r.spec,
        mint: r.mint,
        entry,
        closing: false,
        entryPrice: r.entry_price,
        entrySpot,
        entryLiquidity: r.actual?.entryLiquidity ?? 0,
        openedAt: r.opened_at.getTime(),
        peak: r.actual?.peak ?? entrySpot,
        trough: r.actual?.trough ?? entrySpot,
      });
      this.market.pinned.add(r.mint);
    }
    if (rows.length > 0) this.activity.info("paper", `Recovered ${rows.length} open paper positions after restart`);
  }

  private openCountFor(versionId: string): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.versionId === versionId) n++;
    return n;
  }

  private holding(versionId: string, mint: string): boolean {
    for (const p of this.positions.values()) if (p.versionId === versionId && p.mint === mint) return true;
    return false;
  }

  /** Evaluate a decision point for every active strategy version. */
  async onDecision(dp: DecisionPoint): Promise<void> {
    // exits first: feature-based exits for positions in this token
    for (const p of this.positions.values()) {
      if (p.mint !== dp.mint || p.closing) continue;
      const reason = featureExit(p.spec, p, dp.features);
      if (reason) void this.close(p, reason);
    }
    const s = this.settings();
    if (!s.trading.paperTradingEnabled || this.state !== "RUNNING") return;
    const token = this.market.tokens.get(dp.mint);
    if (!token) return;
    const age = token.ageAt(dp.ts);
    for (const a of this.active) {
      const m = matchSpec(a.version.spec, dp.features, token.venue, age);
      if (!m.matched) continue;
      const key = `${a.version.id}|${dp.mint}`;
      const reasons: string[] = [];
      if (this.holding(a.version.id, dp.mint)) reasons.push("already holding this token");
      const last = this.lastEntry.get(key);
      if (last !== undefined && dp.ts - last < a.version.spec.entry.cooldownSec * 1000) reasons.push("token cooldown");
      if (this.openCountFor(a.version.id) >= s.trading.paperMaxOpenPositionsPerStrategy) reasons.push("strategy position limit reached");
      if (reasons.length > 0) {
        metrics.signals.inc({ mode: "paper", decision: "no_trade" });
        continue; // blocked matches are frequent and not stored individually
      }
      this.lastEntry.set(key, dp.ts);
      await this.enter(a, dp, m.details.map((d) => ({ condition: d.condition, holds: d.holds })));
    }
  }

  private async enter(a: ActiveVersion, dp: DecisionPoint, details: unknown): Promise<void> {
    const s = this.settings();
    const exec = executionParamsFromSettings(s);
    const idem = idempotencyKey("paper", a.version.id, dp.mint, dp.ts);
    const signalId = randomUUID();
    const tradeId = randomUUID();
    const state = this.view.stateAt(dp.mint);
    const est = state ? estimateRoundTripCosts(state, s.trading.paperPositionSizeSol, exec) : null;
    const regimeLabel = dp.regime?.label ?? null;
    const expected = {
      expectedNetReturn: a.expectedNetReturn,
      expectedSlippageSol: est ? est.entryImpact * s.trading.paperPositionSizeSol : null,
      breakEvenMove: est?.breakEvenMove ?? null,
      estimatedCostSol: est?.totalCostSol ?? null,
      regimeCovered: a.goodRegimes === null || regimeLabel === null ? null : a.goodRegimes.has(regimeLabel),
      dataAgeSec: state ? (this.clock.now() - state.ts) / 1000 : null,
      trigger: dp.trigger,
      conditions: details,
    };
    // idempotent insert: the same decision point can never open two trades for one version
    const inserted = await this.db.query(
      `INSERT INTO signals (id, mode, idempotency_key, strategy_id, strategy_version_id, mint, event_id, ts, decision, reasons, expected, features)
       VALUES ($1, 'paper', $2, $3, $4, $5, $6, $7, 'ENTER', $8, $9, $10) ON CONFLICT (idempotency_key) DO NOTHING`,
      [signalId, idem, a.strategyId, a.version.id, dp.mint, dp.eventId, new Date(dp.ts), JSON.stringify({ trigger: dp.trigger, conditions: details }), JSON.stringify(expected), JSON.stringify(compactFeatures(dp.features))],
    );
    if ((inserted.rowCount ?? 0) === 0) return;
    metrics.signals.inc({ mode: "paper", decision: "enter" });
    await this.db.query(
      `INSERT INTO paper_trades (id, idempotency_key, signal_id, strategy_id, strategy_version_id, event_id, mint, status, decision_ts,
         position_size_sol, expected_entry_price, features, expected, regime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPENING', $8, $9, $10, $11, $12, $13)`,
      [tradeId, idem, signalId, a.strategyId, a.version.id, dp.eventId, dp.mint, new Date(dp.ts), s.trading.paperPositionSizeSol, state?.priceSol ?? null, JSON.stringify(compactFeatures(dp.features)), JSON.stringify(expected), dp.regime ? JSON.stringify({ label: dp.regime.label, levels: dp.regime.levels }) : null],
    );
    const symbol = this.market.tokens.get(dp.mint)?.symbol ?? dp.mint.slice(0, 6);
    this.activity.info("paper", `${a.strategyId} match on ${symbol} (${dp.trigger}) → paper entry in ${exec.executionDelayMs}ms`, { mint: dp.mint, strategyId: a.strategyId });

    await sleepMs(exec.executionDelayMs);
    const rnd = seededRandom(hashSeed(tradeId));
    const fill = simulateEntry(this.view, dp.mint, this.clock.now() - exec.executionDelayMs, s.trading.paperPositionSizeSol, exec, rnd);
    if (!fill.ok) {
      await this.db.query(
        `UPDATE paper_trades SET status = 'FAILED', failed_reason = $2, net_pnl_sol = $3, gross_pnl_sol = 0, net_return = $4,
           priority_fees_sol = $5, closed_at = now() WHERE id = $1`,
        [tradeId, fill.reason, -fill.costSol, -fill.costSol / s.trading.paperPositionSizeSol, fill.costSol],
      );
      this.activity.warn("paper", `Paper entry failed for ${a.strategyId} on ${symbol}: ${fill.reason}`, { tradeId });
      return;
    }
    const pos: PaperPosition = {
      id: tradeId,
      strategyId: a.strategyId,
      versionId: a.version.id,
      spec: a.version.spec,
      mint: dp.mint,
      entry: fill,
      closing: false,
      entryPrice: fill.effectivePrice,
      entrySpot: fill.spotPrice,
      entryLiquidity: this.market.tokens.get(dp.mint)?.liquiditySol ?? 0,
      openedAt: fill.execTs,
      peak: fill.spotPrice,
      trough: fill.spotPrice,
    };
    this.positions.set(tradeId, pos);
    this.market.pinned.add(dp.mint);
    this.opened++;
    await this.db.query(
      `UPDATE paper_trades SET status = 'OPEN', opened_at = $2, token_qty = $3, entry_price = $4, gross_entry_sol = $5,
         entry_slippage_sol = $6, entry_fees_sol = $7, entry_rent_sol = $8, priority_fees_sol = $9, network_fees_sol = $10,
         mev_impact_sol = $11, actual = $12 WHERE id = $1`,
      [
        tradeId,
        new Date(fill.execTs),
        fill.tokensRaw.toString(),
        fill.effectivePrice,
        fill.swapSol,
        fill.slippageSol,
        fill.dexFeeSol,
        fill.rentSol,
        fill.priorityFeeSol,
        fill.networkFeeSol,
        fill.mevSol,
        JSON.stringify({ entrySpot: fill.spotPrice, entryLiquidity: pos.entryLiquidity, venue: fill.venue, decimals: this.market.tokens.get(dp.mint)?.decimals ?? 6 }),
      ],
    );
    this.activity.success("paper", `Paper trade opened: ${a.strategyId} ${symbol} @ ${fill.effectivePrice.toExponential(3)} SOL`, { tradeId, mint: dp.mint });
    this.bus.emit("invalidate", ["paper"]);
  }

  private onPrice(u: PriceUpdate): void {
    for (const p of this.positions.values()) {
      if (p.mint !== u.mint || p.closing) continue;
      updateExtremes(p, u.priceSol);
      const reason = priceExit(p.spec, p, u.priceSol, this.clock.now());
      if (reason) void this.close(p, reason);
    }
  }

  private checkTimeExits(): void {
    const now = this.clock.now();
    for (const p of this.positions.values()) {
      if (p.closing) continue;
      const price = this.market.tokens.get(p.mint)?.lastPrice ?? p.entrySpot;
      const reason = priceExit(p.spec, p, price, now);
      if (reason) void this.close(p, reason);
    }
  }

  async close(p: PaperPosition, reason: ExitReason): Promise<void> {
    if (p.closing) return;
    p.closing = true;
    const s = this.settings();
    const exec = executionParamsFromSettings(s);
    try {
      await sleepMs(exec.executionDelayMs);
      const rnd = seededRandom(hashSeed(`${p.id}:exit`));
      const exit = simulateExit(this.view, p.mint, p.entry.tokens, this.clock.now() - exec.executionDelayMs, { ...exec, executionDelayMs: 0 }, rnd);
      let netPnl: number;
      let grossPnl: number;
      let exitFields: unknown[];
      if (exit.ok) {
        const r = tradeResult(p.entry, exit);
        netPnl = r.netPnlSol;
        grossPnl = r.grossPnlSol;
        exitFields = [exit.effectivePrice, exit.receivedSol, exit.slippageSol, exit.dexFeeSol, exit.rentRefundSol, p.entry.priorityFeeSol + exit.priorityFeeSol, p.entry.networkFeeSol + exit.networkFeeSol, p.entry.mevSol + exit.mevSol];
      } else {
        netPnl = -(p.entry.swapSol + p.entry.priorityFeeSol + p.entry.networkFeeSol + p.entry.rentSol + exit.costSol);
        grossPnl = -p.entry.swapSol;
        exitFields = [0, 0, 0, 0, 0, p.entry.priorityFeeSol + exit.costSol, p.entry.networkFeeSol, p.entry.mevSol];
      }
      const spent = p.entry.swapSol + p.entry.priorityFeeSol + p.entry.networkFeeSol + p.entry.rentSol;
      const netReturn = netPnl / spent;
      const exitSpot = exit.ok ? exit.spotPrice : 0;
      await this.db.query(
        `UPDATE paper_trades SET status = 'CLOSED', closed_at = now(), exit_price = $2, gross_exit_sol = $3, exit_slippage_sol = $4,
           exit_fees_sol = $5, exit_rent_refund_sol = $6, priority_fees_sol = $7, network_fees_sol = $8, mev_impact_sol = $9,
           gross_pnl_sol = $10, net_pnl_sol = $11, net_return = $12, max_runup = $13, max_drawdown = $14, exit_reason = $15,
           actual = COALESCE(actual, '{}'::jsonb) || $16::jsonb WHERE id = $1`,
        [
          p.id,
          ...exitFields,
          grossPnl,
          netPnl,
          netReturn,
          p.peak / p.entrySpot - 1,
          p.trough / p.entrySpot - 1,
          exit.ok ? reason : "EXIT_FAILED",
          JSON.stringify({ netReturn, marketMove: exitSpot > 0 ? exitSpot / p.entrySpot - 1 : -1, exitSpot, peak: p.peak, trough: p.trough }),
        ],
      );
      this.positions.delete(p.id);
      if (![...this.positions.values()].some((x) => x.mint === p.mint)) this.market.pinned.delete(p.mint);
      this.closed++;
      const symbol = this.market.tokens.get(p.mint)?.symbol ?? p.mint.slice(0, 6);
      const pct = (netReturn * 100).toFixed(1);
      this.activity.add(netPnl >= 0 ? "success" : "info", "paper", `Paper trade closed: ${p.strategyId} ${symbol} ${reason} → net ${netReturn >= 0 ? "+" : ""}${pct}% (${netPnl.toFixed(5)} SOL)`, {
        tradeId: p.id,
        netPnl,
      });
      this.bus.emit("invalidate", ["paper", "strategies"]);
    } catch (err) {
      p.closing = false;
      this.log.error({ err, trade: p.id }, "closing paper position failed");
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
