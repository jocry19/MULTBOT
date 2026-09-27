import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import type { Clock } from "../../core/clock.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { BusEvents, DecisionPoint } from "../../app/busEvents.js";
import type { MarketEvent } from "../../domain/market.js";
import { ContextBaselines, contextKey, type BaselineSnapshot } from "../anomaly/baselines.js";
import { EventEngine, type DetectedEvent } from "../events/eventEngine.js";
import { applyDerived, type DerivedFeatureDef } from "../features/derived.js";
import { compactFeatures, computeFeatures } from "../features/featureEngine.js";
import type { FeatureVector } from "../features/types.js";
import { computeRegimeMetrics, RegimeEngine, type RegimeState } from "../regime/regimeEngine.js";
import type { WalletBook } from "../wallets/walletBook.js";
import type { ActivityLog } from "../activity/activityLog.js";
import { MarketState } from "./marketState.js";
import type { TokenState } from "./tokenState.js";
import { utcDay } from "../ingest/collector.js";

/** Ages (s) at which every token gets a research sample / strategy evaluation. */
export const AGE_CHECKPOINTS_SEC = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** Human-readable discovery reasons for event types (AI Discovery Feed). */
export function discoveryLabel(type: string): string {
  if (type.startsWith("combo:")) return "Historical pattern combination";
  if (type.startsWith("anomaly:")) {
    const feat = type.split(":")[1] ?? "";
    if (feat.includes("volume")) return "Volume anomaly";
    if (feat.includes("buyer") || feat.includes("holder")) return "Unusual buyer acceleration";
    if (feat.includes("liquidity") || feat.includes("liq")) return "Liquidity event";
    if (feat.includes("smart") || feat.includes("cluster")) return "Wallet cluster event";
    return `Anomaly: ${feat}`;
  }
  const map: Record<string, string> = {
    volume_spike: "Volume anomaly",
    volume_dryup: "Volume dry-up",
    buyer_surge: "Unusual buyer acceleration",
    seller_surge: "Seller surge",
    whale_entry: "Whale entry",
    whale_exit: "Whale exit",
    creator_sell: "Creator pattern: creator selling",
    price_breakout: "Price breakout",
    price_crash: "Price crash",
    price_reversal: "Price reversal",
    holder_acceleration: "Holder acceleration",
    transaction_acceleration: "Transaction acceleration",
    volatility_expansion: "Volatility expansion",
    volatility_compression: "Volatility compression",
    smart_money_entry: "Smart-money entry (evidence-based)",
    smart_money_exit: "Smart-money exit",
    coordinated_buying: "Coordinated buying",
    wallet_cluster_activity: "Wallet cluster event",
    liquidity_drop: "Liquidity event: withdrawal",
    liquidity_add: "Liquidity event: deposit",
    near_completion: "Bonding curve near completion",
    price_volume_divergence: "Price/volume divergence",
    liquidity_volume_divergence: "Liquidity/volume divergence",
    token_created: "New token",
    curve_complete: "Bonding curve completed",
    migration: "Migrated to PumpSwap",
  };
  return map[type] ?? type;
}

export interface IndexerOptions {
  /** Minimum time between evaluations of the same token. */
  evalIntervalMs?: number;
  /** Periodic research sampling interval per active token. */
  sampleIntervalMs?: number;
  /** Minimum trades in the last 60s for periodic sampling. */
  minTradesForSample?: number;
  /** Max tokens evaluated per tick (backpressure). */
  maxEvalsPerTick?: number;
  persist?: boolean;
}

interface PendingSample {
  mint: string;
  ts: number;
  trigger: string;
  eventUid: string | null;
  ageSec: number;
  venue: string;
  features: FeatureVector;
  regime: RegimeState | null;
}

/**
 * Live analysis driver: applies market events to the MarketState, evaluates tokens (features →
 * contextual transforms → derived features → event detection), writes research samples,
 * snapshots, events and regime states, and publishes decision points for strategies.
 */
export class MarketIndexer extends BaseModule {
  readonly market = new MarketState();
  readonly baselines = new ContextBaselines();
  readonly events = new EventEngine();
  readonly regime = new RegimeEngine();
  private readonly dirty = new Set<string>();
  private readonly lastSampleAt = new Map<string, number>();
  private readonly nextCheckpoint = new Map<string, number>();
  private readonly pendingLifecycle: DetectedEvent[] = [];
  private readonly recentEvents = new Map<string, { type: string; label: string; severity: number; ts: number }[]>();
  private readonly tokenStateDirty = new Set<string>();
  private derived: DerivedFeatureDef[] = [];
  private readonly opts: Required<IndexerOptions>;
  evaluations = 0;
  samplesWritten = 0;
  eventsDetected = 0;

  constructor(
    private readonly db: Database | null,
    private readonly bus: TypedBus<BusEvents>,
    private readonly wallets: WalletBook,
    private readonly clock: Clock,
    private readonly activity: ActivityLog | null,
    log: Logger,
    opts: IndexerOptions = {},
  ) {
    super("indexer", log);
    this.opts = {
      evalIntervalMs: opts.evalIntervalMs ?? 5_000,
      sampleIntervalMs: opts.sampleIntervalMs ?? 60_000,
      minTradesForSample: opts.minTradesForSample ?? 3,
      maxEvalsPerTick: opts.maxEvalsPerTick ?? 400,
      persist: opts.persist ?? db !== null,
    };
    bus.on("market.events", (events) => this.onEvents(events));
    this.every("tick", 1_000, () => this.tick());
    this.every("baselines", 30_000, async () => this.baselines.refresh());
    this.every("regime", 60_000, () => this.updateRegime());
    this.every("token-state", 10_000, () => this.flushTokenState());
    this.every("snapshots", 60_000, () => this.writeSnapshots());
    this.every("evict", 5 * 60_000, async () => this.evict());
    this.every("persist-models", 10 * 60_000, () => this.persistModels());
  }

  protected override async onStart(): Promise<void> {
    if (!this.db) return;
    await this.restoreModels();
    await this.loadDerived();
    await this.warmStart();
  }

  protected override async onStop(): Promise<void> {
    await this.persistModels().catch((err) => this.log.error({ err }, "persisting models failed"));
  }

  override healthDetail(): string {
    return `tokens=${this.market.tokens.size} evals=${this.evaluations} samples=${this.samplesWritten} events=${this.eventsDetected} regime=${this.regime.state?.label ?? "-"}`;
  }

  setDerived(defs: DerivedFeatureDef[]): void {
    this.derived = defs;
  }

  async loadDerived(): Promise<void> {
    if (!this.db) return;
    const rows = await this.db.many<{ name: string; expression: string }>(
      "SELECT name, expression FROM features WHERE kind IN ('derived', 'discovered') AND enabled",
    );
    this.derived = rows
      .map((r) => {
        try {
          return JSON.parse(r.expression) as DerivedFeatureDef;
        } catch {
          return null;
        }
      })
      .filter((d): d is DerivedFeatureDef => d !== null);
  }

  /** Apply events (also used by replay in tests). */
  onEvents(events: MarketEvent[], updateWallets = true): void {
    for (const ev of events) {
      const token = this.market.apply(ev);
      if (updateWallets) {
        if (ev.kind === "trade") this.wallets.onTrade(ev.data, token?.createdAt ?? null, token?.creator ?? null);
        else if (ev.kind === "create") this.wallets.onCreate(ev.data);
        else if (ev.kind === "complete") this.wallets.onComplete(ev.data.mint, token?.creator ?? null);
      }
      if (ev.kind === "trade") {
        this.dirty.add(ev.data.mint);
        this.tokenStateDirty.add(ev.data.mint);
        this.bus.emit("market.price", { mint: ev.data.mint, ts: ev.data.ts, priceSol: ev.data.priceSol, liquiditySol: token?.liquiditySol ?? 0 });
      } else if (ev.kind === "create") {
        this.nextCheckpoint.set(ev.data.mint, 0);
      }
      for (const d of this.events.fromMarketEvent(ev)) {
        this.pendingLifecycle.push(d);
        this.rememberEvent(d);
      }
    }
  }

  private rememberEvent(e: DetectedEvent): void {
    if (!e.mint) return;
    const list = this.recentEvents.get(e.mint) ?? [];
    list.push({ type: e.type, label: discoveryLabel(e.type), severity: e.severity, ts: e.ts });
    while (list.length > 30) list.shift();
    this.recentEvents.set(e.mint, list);
    this.tokenStateDirty.add(e.mint);
  }

  /** Discovery score: recency-weighted severity of recent events (explainable, not a magic number). */
  discovery(mint: string, now: number): { score: number; reasons: { type: string; label: string; severity: number; ts: number }[] } {
    const list = (this.recentEvents.get(mint) ?? []).filter((e) => now - e.ts < 15 * 60_000);
    let score = 0;
    for (const e of list) score += Math.min(10, e.severity) * Math.exp(-(now - e.ts) / 300_000);
    const reasons = [...list].sort((a, b) => b.ts - a.ts).slice(0, 8);
    return { score, reasons };
  }

  /** Evaluate one token now: features, context transforms, derived, events. */
  evaluate(t: TokenState, now: number): { features: FeatureVector; detected: DetectedEvent[] } {
    const f = computeFeatures(t, this.market, now, {
      wallets: this.wallets,
      creators: this.wallets,
      eventAges: this.events.eventAges(t.mint, now),
      market: this.regime.features(),
    });
    const ctx = contextKey(t.ageAt(now), t.venue);
    this.baselines.transform(f, ctx);
    applyDerived(this.derived, f);
    const detected = this.events.process(t, f, now);
    // observe after transform so a value never influences its own score
    this.baselines.observe(f, ctx);
    t.lastEvaluatedAt = now;
    t.lastEvaluatedTrades = t.trades;
    this.evaluations++;
    for (const d of detected) this.rememberEvent(d);
    return { features: f, detected };
  }

  private samplingTrigger(t: TokenState, now: number, detected: DetectedEvent[]): string | null {
    if (detected.length > 0) {
      const top = [...detected].sort((a, b) => b.severity - a.severity)[0] as DetectedEvent;
      return `event:${top.type}`;
    }
    const age = t.ageAt(now);
    const idx = this.nextCheckpoint.get(t.mint);
    if (idx !== undefined && idx < AGE_CHECKPOINTS_SEC.length && age >= (AGE_CHECKPOINTS_SEC[idx] as number)) {
      let next = idx;
      while (next < AGE_CHECKPOINTS_SEC.length && age >= (AGE_CHECKPOINTS_SEC[next] as number)) next++;
      this.nextCheckpoint.set(t.mint, next);
      return `age:${AGE_CHECKPOINTS_SEC[next - 1]}`;
    }
    const last = this.lastSampleAt.get(t.mint) ?? 0;
    if (now - last >= this.opts.sampleIntervalMs) {
      const recent = t.tape.window(now - 60_000, now);
      if (recent.trades >= this.opts.minTradesForSample) return "periodic";
    }
    return null;
  }

  async tick(): Promise<void> {
    const now = this.clock.now();
    // tokens due for evaluation: new trades and throttle interval elapsed, or age checkpoint due
    const due: TokenState[] = [];
    for (const mint of this.dirty) {
      const t = this.market.tokens.get(mint);
      if (!t) {
        this.dirty.delete(mint);
        continue;
      }
      if (now - t.lastEvaluatedAt >= this.opts.evalIntervalMs) due.push(t);
    }
    for (const [mint, idx] of this.nextCheckpoint) {
      const t = this.market.tokens.get(mint);
      if (!t || idx >= AGE_CHECKPOINTS_SEC.length) {
        if (!t) this.nextCheckpoint.delete(mint);
        continue;
      }
      if (t.ageAt(now) >= (AGE_CHECKPOINTS_SEC[idx] as number) && !due.includes(t)) due.push(t);
    }
    // most active first; bounded work per tick
    due.sort((a, b) => b.trades - b.lastEvaluatedTrades - (a.trades - a.lastEvaluatedTrades));
    const batch = due.slice(0, this.opts.maxEvalsPerTick);

    const samples: PendingSample[] = [];
    const detectedAll: DetectedEvent[] = [...this.pendingLifecycle.splice(0)];
    for (const t of batch) {
      this.dirty.delete(t.mint);
      const { features, detected } = this.evaluate(t, now);
      detectedAll.push(...detected);
      const trigger = this.samplingTrigger(t, now, detected);
      if (trigger) {
        this.lastSampleAt.set(t.mint, now);
        const top = detected.length > 0 ? [...detected].sort((a, b) => b.severity - a.severity)[0] ?? null : null;
        samples.push({ mint: t.mint, ts: now, trigger, eventUid: top?.uid ?? null, ageSec: Math.round(t.ageAt(now)), venue: t.venue, features, regime: this.regime.state });
      }
    }

    const eventIds = await this.persistEvents(detectedAll);
    for (const d of detectedAll) {
      this.eventsDetected++;
      this.bus.emit("market.detected", { ...d, id: eventIds.get(d.uid) ?? null });
    }
    if (detectedAll.length > 0) this.logNotableEvents(detectedAll);
    const sampleIds = await this.persistSamples(samples, eventIds);
    samples.forEach((s, i) => {
      const dp: DecisionPoint = {
        mint: s.mint,
        ts: s.ts,
        trigger: s.trigger,
        eventId: s.eventUid ? (eventIds.get(s.eventUid) ?? null) : null,
        eventUid: s.eventUid,
        features: s.features,
        regime: s.regime,
        sampleId: sampleIds[i] ?? null,
      };
      this.bus.emit("market.decision", dp);
    });
  }

  private logNotableEvents(events: DetectedEvent[]): void {
    if (!this.activity) return;
    const notable = events.filter((e) => !e.type.startsWith("anomaly:") && e.type !== "token_created" && e.severity >= 4);
    for (const e of notable.slice(0, 3)) {
      const t = e.mint ? this.market.tokens.get(e.mint) : undefined;
      this.activity.info("events", `Detected ${discoveryLabel(e.type).toLowerCase()} on ${t?.symbol ?? e.mint?.slice(0, 6) ?? "market"}`, {
        mint: e.mint,
        type: e.type,
        severity: e.severity,
      });
    }
  }

  private async persistEvents(events: DetectedEvent[]): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    if (!this.db || !this.opts.persist || events.length === 0) return ids;
    try {
      const params: unknown[] = [];
      const values = events.map((e) => {
        params.push(e.uid, e.type, e.mint, new Date(e.ts), new Date(e.availableAt), e.severity, e.direction, e.detector, e.detectorVersion, JSON.stringify(e.context));
        const b = params.length - 10;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
      });
      const res = await this.db.query<{ id: number; event_uid: string }>(
        `INSERT INTO events (event_uid, type, mint, ts, available_at, severity, direction, detector, detector_version, context)
         VALUES ${values.join(",")} ON CONFLICT (event_uid) DO NOTHING RETURNING id, event_uid`,
        params,
      );
      for (const r of res.rows) ids.set(r.event_uid, r.id);
    } catch (err) {
      this.log.error({ err }, "persisting events failed");
    }
    return ids;
  }

  private async persistSamples(samples: PendingSample[], eventIds: Map<string, number>): Promise<(number | null)[]> {
    if (!this.db || !this.opts.persist || samples.length === 0) return samples.map(() => null);
    try {
      const days = new Set(samples.map((s) => utcDay(s.ts)));
      for (const d of days) await this.db.query("SELECT ensure_daily_partition('research_samples', $1::date)", [d]);
      const params: unknown[] = [];
      const values = samples.map((s) => {
        params.push(
          s.mint,
          new Date(s.ts),
          new Date(s.ts),
          s.trigger,
          s.eventUid ? (eventIds.get(s.eventUid) ?? null) : null,
          s.ageSec,
          s.venue,
          JSON.stringify(compactFeatures(s.features)),
          s.regime ? JSON.stringify({ label: s.regime.label, levels: s.regime.levels }) : null,
        );
        const b = params.length - 9;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
      });
      const res = await this.db.query<{ id: number }>(
        `INSERT INTO research_samples (mint, ts, available_at, trigger, event_id, age_sec, venue, features, regime)
         VALUES ${values.join(",")} RETURNING id`,
        params,
      );
      this.samplesWritten += res.rows.length;
      return res.rows.map((r) => r.id);
    } catch (err) {
      this.log.error({ err }, "persisting research samples failed");
      return samples.map(() => null);
    }
  }

  async updateRegime(): Promise<void> {
    const now = this.clock.now();
    const prev = this.regime.state?.label;
    const state = this.regime.update(computeRegimeMetrics(this.market, now), now);
    this.bus.emit("market.regime", state);
    if (prev && prev !== state.label) {
      this.activity?.info("regime", `Market regime changed: ${prev} → ${state.label}`, { levels: state.levels });
      this.pendingLifecycle.push({
        uid: `regime_shift:${now}`,
        type: "regime_shift",
        mint: null,
        ts: now,
        availableAt: now,
        severity: 1,
        direction: 0,
        detector: "regime",
        detectorVersion: 1,
        context: { ...state.percentiles },
      });
    }
    if (!this.db || !this.opts.persist) return;
    await this.db.query(
      `INSERT INTO market_regimes (ts, available_at, window_sec, metrics, levels, label) VALUES ($1, $1, 300, $2, $3, $4)
       ON CONFLICT (ts) DO NOTHING`,
      [new Date(now), JSON.stringify(state.metrics), JSON.stringify(state.levels), state.label],
    );
  }

  async flushTokenState(): Promise<void> {
    if (!this.db || !this.opts.persist || this.tokenStateDirty.size === 0) return;
    const now = this.clock.now();
    const mints = [...this.tokenStateDirty];
    this.tokenStateDirty.clear();
    const rows: unknown[][] = [];
    for (const mint of mints) {
      const t = this.market.tokens.get(mint);
      if (!t || t.lastTradeAt === 0) continue;
      const w5 = t.tape.window(now - 300_000, now);
      const w60 = t.tape.window(now - 3_600_000, now);
      const bars24 = t.bars.sum(now - 24 * 3_600_000, now + 60_000);
      const p5 = t.tape.priceAt(now - 300_000);
      const p60 = t.tape.priceAt(now - 3_600_000);
      const disc = this.discovery(mint, now);
      rows.push([
        mint,
        t.venue,
        new Date(t.lastTradeAt),
        t.lastPrice,
        t.marketCapSol,
        t.liquiditySol,
        t.athPrice,
        t.bondingProgress,
        w5.volSol,
        w60.volSol,
        bars24.vol,
        w5.buys,
        w5.sells,
        t.trades,
        t.traderFirstSeen.size,
        t.holderCount(),
        p5 ? t.lastPrice / p5 - 1 : null,
        p60 ? t.lastPrice / p60 - 1 : null,
        disc.score,
        JSON.stringify(disc.reasons),
      ]);
    }
    if (rows.length === 0) return;
    await this.db.insertMany(
      "token_state",
      [
        "mint",
        "venue",
        "last_trade_at",
        "price_sol",
        "market_cap_sol",
        "liquidity_sol",
        "ath_price_sol",
        "bonding_progress",
        "volume_sol_5m",
        "volume_sol_1h",
        "volume_sol_24h",
        "buys_5m",
        "sells_5m",
        "trades_total",
        "unique_traders",
        "holders",
        "price_change_5m",
        "price_change_1h",
        "discovery_score",
        "discovery_reasons",
      ],
      rows,
      `ON CONFLICT (mint) DO UPDATE SET venue = EXCLUDED.venue, last_trade_at = EXCLUDED.last_trade_at, price_sol = EXCLUDED.price_sol,
        market_cap_sol = EXCLUDED.market_cap_sol, liquidity_sol = EXCLUDED.liquidity_sol,
        ath_price_sol = GREATEST(token_state.ath_price_sol, EXCLUDED.ath_price_sol), bonding_progress = EXCLUDED.bonding_progress,
        volume_sol_5m = EXCLUDED.volume_sol_5m, volume_sol_1h = EXCLUDED.volume_sol_1h, volume_sol_24h = EXCLUDED.volume_sol_24h,
        buys_5m = EXCLUDED.buys_5m, sells_5m = EXCLUDED.sells_5m,
        trades_total = GREATEST(token_state.trades_total, EXCLUDED.trades_total),
        unique_traders = GREATEST(token_state.unique_traders, EXCLUDED.unique_traders), holders = EXCLUDED.holders,
        price_change_5m = EXCLUDED.price_change_5m, price_change_1h = EXCLUDED.price_change_1h,
        discovery_score = EXCLUDED.discovery_score, discovery_reasons = EXCLUDED.discovery_reasons, updated_at = now()`,
    );
  }

  /** Minute bars → volume/liquidity snapshots; token snapshots with features for active tokens. */
  async writeSnapshots(): Promise<void> {
    if (!this.db || !this.opts.persist) return;
    const now = this.clock.now();
    const bucketStart = Math.floor(now / 60_000) * 60_000 - 60_000; // last completed minute
    const vol: unknown[][] = [];
    const liq: unknown[][] = [];
    const snaps: unknown[][] = [];
    const holderRows: unknown[][] = [];
    for (const t of this.market.activeTokens(now, 120_000)) {
      const bar = t.bars.bars.find((b) => b.t === bucketStart);
      if (bar) {
        vol.push([t.mint, new Date(bar.t), new Date(bar.t + 60_000), bar.o, bar.h, bar.l, bar.c, bar.buyVol, bar.sellVol, bar.buys, bar.sells, bar.buyers.size, bar.sellers.size]);
        liq.push([
          t.mint,
          new Date(bar.t),
          new Date(bar.t + 60_000),
          t.venue,
          t.pool,
          bar.liquidity,
          t.curve ? Number(t.curve.virtualSolReserves) : null,
          t.curve ? Number(t.curve.realSolReserves) : null,
          t.curve ? t.curve.realTokenReserves.toString() : null,
          bar.c * (Number(t.supply) / 10 ** t.decimals),
        ]);
        const f = computeFeatures(t, this.market, now, { wallets: this.wallets, creators: this.wallets, market: this.regime.features() });
        snaps.push([t.mint, new Date(now), new Date(now), Math.round(t.ageAt(now)), t.venue, t.lastPrice, t.marketCapSol, t.liquiditySol, t.holderCount(), JSON.stringify(compactFeatures(f))]);
        // top holders of active tokens
        const top = [...t.holders.entries()].sort((a, b) => b[1].balance - a[1].balance).slice(0, 50);
        for (const [owner, h] of top) {
          holderRows.push([t.mint, owner, BigInt(Math.round(h.balance * 10 ** t.decimals)).toString(), new Date(h.firstAt), new Date(h.lastAt), "trades"]);
        }
      }
    }
    for (const table of ["volume_snapshots", "liquidity_snapshots", "token_snapshots"]) {
      await this.db.query("SELECT ensure_daily_partition($1, $2::date)", [table, utcDay(bucketStart)]);
      await this.db.query("SELECT ensure_daily_partition($1, $2::date)", [table, utcDay(now)]);
    }
    await this.db.insertMany(
      "volume_snapshots",
      ["mint", "ts", "available_at", "open_price", "high_price", "low_price", "close_price", "buy_volume_sol", "sell_volume_sol", "buys", "sells", "unique_buyers", "unique_sellers"],
      vol,
      "ON CONFLICT DO NOTHING",
    );
    await this.db.insertMany(
      "liquidity_snapshots",
      ["mint", "ts", "available_at", "venue", "pool", "liquidity_sol", "virtual_sol_reserves", "real_sol_reserves", "real_token_reserves", "market_cap_sol"],
      liq,
      "ON CONFLICT DO NOTHING",
    );
    await this.db.insertMany(
      "token_snapshots",
      ["mint", "ts", "available_at", "age_sec", "venue", "price_sol", "market_cap_sol", "liquidity_sol", "holders", "features"],
      snaps,
      "ON CONFLICT DO NOTHING",
    );
    await this.db.insertMany(
      "holders",
      ["mint", "owner", "balance", "first_acquired_at", "last_change_at", "source"],
      holderRows,
      "ON CONFLICT (mint, owner) DO UPDATE SET balance = EXCLUDED.balance, last_change_at = EXCLUDED.last_change_at",
    );
  }

  private evict(): void {
    const now = this.clock.now();
    const evicted = this.market.evict(now);
    for (const m of evicted) {
      this.events.forget(m);
      this.lastSampleAt.delete(m);
      this.nextCheckpoint.delete(m);
      this.recentEvents.delete(m);
    }
    this.wallets.evict(now);
    if (evicted.length > 0) this.log.debug({ evicted: evicted.length, remaining: this.market.tokens.size }, "evicted inactive tokens");
  }

  async persistModels(): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO learning_state (key, value, updated_at) VALUES ('baselines', $1, now()), ('regime_history', $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(this.baselines.snapshot()), JSON.stringify(this.regime.snapshot())],
    );
  }

  private async restoreModels(): Promise<void> {
    if (!this.db) return;
    const rows = await this.db.many<{ key: string; value: unknown }>(
      "SELECT key, value FROM learning_state WHERE key IN ('baselines', 'regime_history')",
    );
    for (const r of rows) {
      if (r.key === "baselines") this.baselines.restore(r.value as BaselineSnapshot);
      if (r.key === "regime_history") this.regime.restore(r.value as Record<string, number[]>);
    }
  }

  /**
   * Crash recovery for the analysis state: rebuild recent token state from persisted trades
   * (tokens created in the last 2h fully, plus the last hour of trades for older active tokens).
   */
  async warmStart(): Promise<void> {
    if (!this.db) return;
    const now = this.clock.now();
    const since = new Date(now - 2 * 3_600_000);
    const creates = await this.db.many<Record<string, unknown>>(
      `SELECT mint, name, symbol, creator, created_at, is_mayhem_mode, total_supply, bonding_curve, create_signature, created_slot
       FROM tokens WHERE created_at >= $1 ORDER BY created_at`,
      [since],
    );
    const events: MarketEvent[] = creates.map((c) => ({
      kind: "create",
      data: {
        signature: String(c.create_signature ?? ""),
        slot: Number(c.created_slot ?? 0),
        ts: new Date(c.created_at as string).getTime(),
        availableAt: new Date(c.created_at as string).getTime(),
        mint: String(c.mint),
        name: String(c.name ?? ""),
        symbol: String(c.symbol ?? ""),
        uri: "",
        creator: String(c.creator ?? ""),
        user: String(c.creator ?? ""),
        bondingCurve: String(c.bonding_curve ?? ""),
        tokenProgram: null,
        quoteMint: null,
        isMayhemMode: Boolean(c.is_mayhem_mode),
        isCashback: false,
        virtualSolReserves: 0n,
        virtualTokenReserves: 0n,
        realTokenReserves: 0n,
        tokenTotalSupply: c.total_supply ? BigInt(String(c.total_supply)) : 1_000_000_000_000_000n,
        source: "backfill",
      },
    }));
    const trades = await this.db.many<Record<string, unknown>>(
      `SELECT * FROM market_trades WHERE ts >= $1 AND (ts >= $2 OR mint IN (SELECT mint FROM tokens WHERE created_at >= $1))
       ORDER BY ts, signature, event_index LIMIT 2000000`,
      [since, new Date(now - 3_600_000)],
    );
    for (const r of trades) {
      events.push({
        kind: "trade",
        data: {
          signature: String(r.signature),
          eventIndex: Number(r.event_index),
          slot: Number(r.slot),
          ts: new Date(r.ts as string).getTime(),
          availableAt: new Date(r.available_at as string).getTime(),
          mint: String(r.mint),
          venue: r.venue as "pump_curve" | "pump_amm",
          pool: (r.pool as string | null) ?? null,
          trader: String(r.trader),
          isBuy: Boolean(r.is_buy),
          solAmount: BigInt(Number(r.sol_amount)),
          tokenAmount: BigInt(String(r.token_amount)),
          feeLamports: BigInt(Number(r.fee_lamports ?? 0)),
          feeBps: (r.fee_bps as number | null) ?? null,
          priceSol: Number(r.price_sol),
          marketCapSol: (r.market_cap_sol as number | null) ?? null,
          virtualSolReserves: r.virtual_sol_reserves !== null ? BigInt(Number(r.virtual_sol_reserves)) : null,
          virtualTokenReserves: r.virtual_token_reserves !== null ? BigInt(String(r.virtual_token_reserves)) : null,
          realSolReserves: r.real_sol_reserves !== null ? BigInt(Number(r.real_sol_reserves)) : null,
          realTokenReserves: r.real_token_reserves !== null ? BigInt(String(r.real_token_reserves)) : null,
          tokenDecimals: 6,
          tokenSupply: null,
          ixName: (r.ix_name as string | null) ?? null,
          mayhemMode: false,
          source: "backfill",
        },
      });
    }
    events.sort((a, b) => a.data.ts - b.data.ts);
    // wallet totals are already persisted → do not double count
    this.onEvents(events, false);
    this.pendingLifecycle.length = 0;
    this.dirty.clear();
    for (const [mint, t] of this.market.tokens) {
      // skip age checkpoints that already passed
      const age = t.ageAt(now);
      const idx = AGE_CHECKPOINTS_SEC.findIndex((a) => a > age);
      this.nextCheckpoint.set(mint, idx === -1 ? AGE_CHECKPOINTS_SEC.length : idx);
      t.lastEvaluatedAt = now;
    }
    if (events.length > 0) this.log.info({ tokens: this.market.tokens.size, trades: trades.length }, "market state warm start complete");
  }
}
