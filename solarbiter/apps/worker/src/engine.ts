import { CandidateQueue, OpportunityEvaluator, screen, type Candidate, type EvaluationContext, type FeeModel } from "@solarbiter/arbitrage";
import { PARTITIONED_TABLES, STATE_KEYS, ensurePartitions, migrate } from "@solarbiter/database";
import type { LiveTradeRecord } from "@solarbiter/execution-engine";
import { minOutForSlippage } from "@solarbiter/jupiter";
import { optimizeThresholds, shouldRollback, type LearningSample } from "@solarbiter/learning-engine";
import { Portfolio, type PaperTradeRecord } from "@solarbiter/paper-engine";
import { closingGuard } from "@solarbiter/profit-engine";
import { evaluateBreakers, evaluateLiveLevel, levelUpEligibility, scalingSuggestion, type LevelTradeStats, type RiskContext } from "@solarbiter/risk-engine";
import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  DEFAULT_BOT_CONTROL,
  DEFAULT_EMERGENCY,
  DEFAULT_LIVE_GATE,
  DEFAULT_TOKENS,
  LIVE_ONLY_BREAKERS,
  SELF_TUNABLE_STRATEGY_KEYS,
  SOL_MINT,
  USDC_MINT,
  bps,
  eurToLamports,
  isRiskNotIncreased,
  lamportsToEur,
  mean,
  mergeSettings,
  quantile,
  type BotControlState,
  type BotState,
  type CircuitBreakerId,
  type ControlCommand,
  type EmergencyState,
  type ExecutionFeatures,
  type LiveGateRecord,
  type LiveLevel,
  type Opportunity,
  type PaperStartRecord,
  type PoolInfo,
  type TradeMode,
  type WorkerStatus,
} from "@solarbiter/shared";
import {
  KEY_MARKETS,
  KEY_SCANNER_TABLE,
  KEY_WORKER_HEARTBEAT,
  KEY_WORKER_LEARNING,
  KEY_WORKER_PORTFOLIO,
  KEY_WORKER_RISK,
  KEY_WORKER_STARTUP,
  KEY_WORKER_STATUS,
  PeriodicTask,
  errorMessage,
  processMetrics,
} from "@solarbiter/shared/node";
import { choosePriorityFee } from "@solarbiter/solana";
import { balancesMatch } from "@solarbiter/wallet";
import type { Logger } from "pino";
import type { Runtime } from "./runtime.js";

interface StartupStep {
  step: string;
  ok: boolean;
  detail: string;
  at: number;
}

interface ScannerRow {
  id: string;
  ts: number;
  type: string;
  route: string[];
  dexes: string[];
  sizeEur: number;
  grossBps: number;
  netEur: number;
  netBps: number;
  probability: number;
  quoteAgeMs: number;
  status: string;
  reason: string | null;
  detail: string | null;
}

/** Screening rejections are counted per minute (far too many to store individually). */
class NoTradeCounter {
  private readonly counts = new Map<string, number>();
  add(reason: string, strategyType: string, n: number): void {
    if (n <= 0) return;
    const k = `${reason}|${strategyType}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }
  drain(): { reason: string; strategyType: string; count: number }[] {
    const out = [...this.counts.entries()].map(([k, count]) => {
      const [reason, strategyType] = k.split("|") as [string, string];
      return { reason, strategyType, count };
    });
    this.counts.clear();
    return out;
  }
}

const symbolOf = (rt: Runtime, m: string): string => rt.tokens.symbol(m);
const LIVE_ONLY_BREAKERS_SET = new Set<CircuitBreakerId>(LIVE_ONLY_BREAKERS);

/**
 * The worker's trading engine:
 *   startup sequence (→ PAPER, or BOT NOT READY) · market data loop (pool state → screening →
 *   firm quotes → opportunity) · risk gate · paper / shadow / live execution · learning after every
 *   trade · circuit breakers · live gate (recommendation only) · strategy versions with rollback ·
 *   status snapshots for the API.
 */
export class TradingEngine {
  private ready = false;
  private initializing = false;
  private notReadyReasons: string[] = [];
  private startup: StartupStep[] = [];
  private readonly startedAt = Date.now();
  private readonly tasks: PeriodicTask[] = [];
  private initTask: PeriodicTask | null = null;
  private paper!: Portfolio;
  private paperEpochAt = 0;
  private live!: Portfolio;
  private readonly queue: CandidateQueue;
  private evaluator!: OpportunityEvaluator;
  private strategyVersionId: string | null = null;
  private lastScanAt: number | null = null;
  private readonly screenedLog: { t: number; screened: number; candidates: number }[] = [];
  private readonly recent: ScannerRow[] = [];
  private lastCandidates: Candidate[] = [];
  private readonly slippageDeviations: number[] = [];
  private readonly recentTxFailures: boolean[] = [];
  private readonly cuSamples = new Map<number, number[]>();
  private readonly noTrade = new NoTradeCounter();
  private balanceMatch: boolean | null = null;
  private walletMatches: boolean | null = null;
  private levelStats: LevelTradeStats & { level: number; devBps: number[] } = { level: 1, netEur: [], failures: 0, attempts: 0, consecutiveFailures: 0, drawdownEur: 0, liveVsPaperBps: null, devBps: [] };
  private controlChain: Promise<void> = Promise.resolve();
  private lastLearningMetricAt = 0;
  private lastFeePersistAt = 0;
  private subscribed = false;
  private stopped = false;

  constructor(
    private readonly rt: Runtime,
    private readonly log: Logger,
  ) {
    this.queue = new CandidateQueue({ maxPerMinute: 4, cooldownMs: 30_000, improvementBps: 5, maxAgeMs: 20_000 });
  }

  // =============================================================================================
  // state
  // =============================================================================================
  private control(): BotControlState {
    return this.rt.store.getState<BotControlState>(STATE_KEYS.bot, DEFAULT_BOT_CONTROL);
  }
  private emergency(): EmergencyState {
    return this.rt.store.getState<EmergencyState>(STATE_KEYS.emergency, DEFAULT_EMERGENCY);
  }
  private gateRecord(): LiveGateRecord {
    return this.rt.store.getState<LiveGateRecord>(STATE_KEYS.liveGate, DEFAULT_LIVE_GATE);
  }
  private shadow(): boolean {
    return this.rt.store.getState<boolean>(STATE_KEYS.shadow, false) === true;
  }

  private liveActive(): boolean {
    return this.gateRecord().state === "LIVE_ENABLED" && this.rt.config.liveMode && this.rt.wallet.configured;
  }

  botState(): BotState {
    if (this.stopped) return "OFFLINE";
    if (!this.ready) return this.initializing ? "INITIALIZING" : "NOT_READY";
    if (this.emergency().active || this.rt.settings.risk.emergencyStop) return "EMERGENCY_STOP";
    if (this.control().desired === "PAUSED") return "PAUSED";
    if (this.liveActive()) return "LIVE";
    if (this.shadow() && this.rt.wallet.configured) return "SHADOW";
    return "PAPER";
  }

  // =============================================================================================
  // startup sequence: config → DB → Redis → Solana → RPC/quotes/adapters/wallet → balance →
  // risk state → strategy → market data → PAPER (else BOT NOT READY, retried)
  // =============================================================================================
  async start(): Promise<void> {
    this.every("status", 2_000, () => this.publishStatus(), true);
    this.initTask = new PeriodicTask("init", 30_000, () => this.tryInit(), this.log, { runImmediately: true });
    this.initTask.start();
  }

  private async tryInit(): Promise<void> {
    if (this.ready || this.initializing) return;
    this.initializing = true;
    this.startup = [];
    try {
      await this.init();
      this.ready = true;
      this.notReadyReasons = [];
      this.initTask?.stop();
      this.startTasks();
      await this.event("success", "system", `SOLARBITER ready — ${this.botState()}`);
      await this.rt.notifications.notify({ type: "SYSTEM", severity: "success", title: "SOLARBITER ready", message: `Startup complete, mode ${this.botState()}` });
    } catch (err) {
      this.notReadyReasons = this.startup.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`);
      if (this.notReadyReasons.length === 0) this.notReadyReasons = [errorMessage(err)];
      this.log.error({ reasons: this.notReadyReasons }, "BOT NOT READY — retrying in 30 s");
    } finally {
      this.initializing = false;
      await this.rt.bus.setJson(KEY_WORKER_STARTUP, { steps: this.startup, ready: this.ready, notReadyReasons: this.notReadyReasons }, 120).catch(() => undefined);
    }
  }

  private async step<T>(name: string, fn: () => Promise<T>, detail: (r: T) => string = () => "ok"): Promise<T> {
    try {
      const r = await fn();
      this.startup.push({ step: name, ok: true, detail: detail(r), at: Date.now() });
      return r;
    } catch (err) {
      this.startup.push({ step: name, ok: false, detail: errorMessage(err), at: Date.now() });
      throw err;
    }
  }

  private async init(): Promise<void> {
    const rt = this.rt;
    await this.step("config", async () => rt.config, (c) => `paper ${c.paperMode ? "on" : "off"}, live switch ${c.liveMode ? "ON" : "off"}`);
    await this.step("database", async () => {
      if (!(await rt.db.ping())) throw new Error("PostgreSQL unreachable");
      const applied = await migrate(rt.db, this.log);
      const now = new Date();
      for (const t of PARTITIONED_TABLES) await ensurePartitions(rt.db, t, now, new Date(now.getTime() + 3 * 86_400_000));
      return applied;
    }, (n) => `connected, ${n} migration(s) applied`);
    await this.step("redis", async () => {
      if (!rt.bus.isHealthy) await rt.bus.connect();
      const ms = await rt.bus.ping();
      if (!this.subscribed) {
        rt.bus.onControl((c) => this.onControl(c));
        await rt.bus.subscribe({ control: true });
        this.subscribed = true;
      }
      return ms;
    }, (ms) => `connected (${ms} ms)`);
    await this.step("settings", async () => {
      rt.settings = await rt.store.load(rt.config.initialSettings);
      rt.store.onChange((s) => this.applySettings(s));
      this.applySettings(rt.settings);
      return rt.settings;
    }, (s) => `capital ${s.capital.startingCapitalEur} €, max trade ${s.capital.maxTradeEur} €, reserve ${s.capital.reserveCapitalEur} €`);
    await this.step("solana_rpc", async () => {
      if (rt.rpc.health().state !== "RUNNING") await rt.rpc.start();
      await rt.rpc.checkHealth();
      const st = rt.rpc.componentStatus();
      if (st !== "CONNECTED" && st !== "DEGRADED") throw new Error(`no healthy RPC endpoint (${rt.rpc.healthDetail()})`);
      return rt.rpc.healthDetail();
    }, (d) => d);
    await this.step("sol_eur", () => rt.fx.refresh(), (q) => `SOL/EUR ${q.price.toFixed(2)} (${q.source})`);
    await this.step("tokens", async () => {
      const s = rt.settings;
      const list = await rt.tokens.load(DEFAULT_TOKENS, { allowlist: s.risk.tokenAllowlist, denylist: s.risk.tokenDenylist });
      await rt.repo.upsertTokens(list);
      if (!rt.tokens.isTradable(SOL_MINT)) throw new Error("SOL mint could not be verified");
      return rt.tokens.safe().length;
    }, (n) => `${n} tradable tokens verified on-chain`);
    await this.step("dex_adapters", async () => {
      const ok = rt.registry.available().map((a) => a.id);
      if (ok.length < 2) throw new Error("fewer than two DEX adapters available");
      return ok;
    }, (ids) => ids.join(", "));
    await this.step("quote_provider", async () => {
      const q = await rt.jupiter.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, inputDecimals: 9, outputDecimals: 6, amount: 10_000_000n, slippageBps: 50, onlyDirectRoutes: false, priority: "verify", maxWaitMs: 5_000 }, null, "jupiter");
      return q;
    }, (q) => `Jupiter quote ok (slot ${q.slot}, ${q.latencyMs} ms)`);
    await this.step("pools", () => this.discoverPools(), (n) => `${n} pools tracked`);
    await this.step("wallet", async () => {
      if (!rt.wallet.configured) return rt.wallet.loadError ?? "not configured";
      await rt.wallet.refresh();
      await this.checkWalletIdentity();
      return `${rt.wallet.address} — ${lamportsToEur(rt.wallet.lamports ?? 0n, rt.fx.price() ?? 0).toFixed(2)} €`;
    }, (d) => (rt.wallet.configured ? d : `${d} (paper only)`));
    await this.step("jito", async () => {
      if (!rt.settings.strategy.useJito) return "disabled in settings";
      try {
        const accts = await rt.jitoClient.getTipAccounts();
        const floor = await rt.jitoClient.refreshTipFloor();
        return `${accts.length} tip accounts, p50 tip ${floor.p50} lamports`;
      } catch (err) {
        return `unavailable (${errorMessage(err)}) — Jito breaker will block live`;
      }
    }, (d) => d);
    await this.step("execution", async () => {
      rt.initExecution();
      this.evaluator = new OpportunityEvaluator(rt.registry, this.feeModel(), rt.learning);
      return rt.jitoEnabled ? "Jito bundles" : "RPC transactions";
    }, (d) => d);
    await this.step("risk_state", async () => {
      rt.breakers.restore(rt.store.getState(STATE_KEYS.breakers, []));
      rt.breakers.onChange((c) => void this.onBreakerChange(c.id, c.open, c.reason, c.by));
      return rt.breakers.open();
    }, (open) => (open.length ? `open breakers: ${open.join(", ")}` : "no open breakers"));
    await this.step("strategy", async () => {
      this.strategyVersionId = await rt.repo.ensureInitialVersion(rt.settings.strategy);
      await rt.store.setState(STATE_KEYS.activeStrategy, this.strategyVersionId);
      return this.strategyVersionId;
    }, (id) => id);
    await this.step("learning", async () => {
      const samples = await rt.repo.loadLearningSamples();
      const opps = await rt.repo.countOpportunities("paper");
      rt.learning.load(samples, opps);
      for (const s of samples) if (s.realizedSlippageBps !== null) this.slippageDeviations.push(s.realizedSlippageBps - s.predictedSlippageBps);
      this.slippageDeviations.splice(0, Math.max(0, this.slippageDeviations.length - 20));
      return { samples: samples.length, opps };
    }, (r) => `${r.samples} samples, ${r.opps} paper opportunities`);
    await this.step("portfolios", async () => {
      const solEur = rt.fx.price() as number;
      let start = rt.store.getState<PaperStartRecord | null>(STATE_KEYS.paperStart, null);
      if (!start) {
        start = { lamports: eurToLamports(rt.settings.capital.paperCapitalEur, solEur).toString(), solEur, at: Date.now(), capitalEur: rt.settings.capital.paperCapitalEur };
        await rt.store.setState(STATE_KEYS.paperStart, start);
      }
      await this.loadPaperEpoch(start);
      this.live = new Portfolio("live", rt.wallet.lamports ?? 0n);
      const liveTrades = await rt.repo.loadClosedTrades("live");
      this.live.restore(liveTrades);
      if (rt.wallet.lamports !== null) this.live.balanceLamports = rt.wallet.lamports;
      this.levelStats.level = rt.settings.risk.liveLevel;
      return { paper: this.paper.snapshot(solEur), live: liveTrades.length };
    }, (r) => `paper ${r.paper.equityEur.toFixed(2)} € (${r.paper.trades} trades), live ${r.live} trades`);
  }

  private startTasks(): void {
    const s = this.rt.settings;
    this.every("scan", s.scanner.poolPollMs, () => this.scanTick());
    this.every("fx", 30_000, async () => {
      const q = await this.rt.fx.refresh();
      await this.rt.repo.insertFx(q.price, q.ts, q.source);
    });
    this.every("fees", 10_000, () => this.feesTick(), true);
    this.every("breakers", 5_000, () => this.breakerTick());
    this.every("wallet", 30_000, () => this.walletTick());
    this.every("discovery", s.scanner.poolRefreshMin * 60_000, async () => {
      await this.discoverPools();
    });
    this.every("learning", 30_000, () => this.learningTick(), true);
    if (s.learning.optimizeIntervalMin > 0) this.every("optimizer", s.learning.optimizeIntervalMin * 60_000, () => this.optimizerTick());
    this.every("partitions", 6 * 3_600_000, async () => {
      const now = new Date();
      for (const t of PARTITIONED_TABLES) await ensurePartitions(this.rt.db, t, now, new Date(now.getTime() + 3 * 86_400_000));
    });
    this.every("no_trade_stats", 60_000, async () => {
      const t = Date.now();
      for (const r of this.noTrade.drain()) await this.rt.repo.addNoTradeStats(t, r.reason, r.strategyType, r.count);
    });
    this.every("state_reload", 10_000, async () => {
      await this.rt.store.reloadState();
      await this.rt.store.refresh();
      // a paper reset whose control message got lost is picked up here
      const start = this.rt.store.getState<PaperStartRecord | null>(STATE_KEYS.paperStart, null);
      if (start && start.at !== this.paperEpochAt) await this.loadPaperEpoch(start);
    });
  }

  private every(name: string, ms: number, fn: () => Promise<void>, runImmediately = false): PeriodicTask {
    const t = new PeriodicTask(name, ms, fn, this.log, { runImmediately });
    this.tasks.push(t);
    t.start();
    return t;
  }

  private task(name: string): PeriodicTask | undefined {
    return this.tasks.find((t) => t.name === name);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.initTask?.stop();
    for (const t of this.tasks) t.stop();
    await this.publishStatus().catch(() => undefined);
  }

  private applySettings(s: typeof this.rt.settings): void {
    this.rt.settings = s;
    this.queue.configure({ maxPerMinute: s.scanner.maxCandidatesPerMinute, maxAgeMs: Math.max(10_000, s.scanner.poolPollMs * 10) });
    this.task("scan")?.setIntervalMs(s.scanner.poolPollMs);
    this.task("discovery")?.setIntervalMs(s.scanner.poolRefreshMin * 60_000);
    this.rt.tokens.applyPolicy({ allowlist: s.risk.tokenAllowlist, denylist: s.risk.tokenDenylist });
    if (this.levelStats.level !== s.risk.liveLevel) this.levelStats = { level: s.risk.liveLevel, netEur: [], failures: 0, attempts: 0, consecutiveFailures: 0, drawdownEur: 0, liveVsPaperBps: null, devBps: [] };
  }

  // =============================================================================================
  // market data
  // =============================================================================================
  private async discoverPools(): Promise<number> {
    const rt = this.rt;
    const s = rt.settings;
    const safe = rt.tokens.safe().map((t) => t.mint);
    const pairs: [string, string][] = [];
    for (const m of safe) if (m !== SOL_MINT) pairs.push([SOL_MINT, m]);
    if (s.strategy.triangularEnabled) for (const m of safe) if (m !== SOL_MINT && m !== USDC_MINT) pairs.push([USDC_MINT, m]);
    const adapters = rt.registry.all().filter((a) => a.poolKinds.length > 0);
    const found: PoolInfo[] = [];
    const errors: string[] = [];
    const jobs = pairs.flatMap(([a, b]) => adapters.map((ad) => async () => {
      try {
        found.push(...(await ad.discoverPools(a, b, { minTvlUsd: s.scanner.minPoolTvlUsd, limit: s.scanner.maxPoolsPerTokenPerDex })));
      } catch (err) {
        errors.push(`${ad.id} ${symbolOf(rt, b)}: ${errorMessage(err)}`);
      }
    }));
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((j) => j()));
    const unique = [...new Map(found.map((p) => [p.address, p])).values()];
    let pools = unique;
    if (unique.length < 2) {
      pools = await rt.repo.loadPools();
      this.log.warn({ errors: errors.slice(0, 5) }, "pool discovery failed — using last known pools from the database");
    } else {
      await rt.repo.upsertPools(unique);
    }
    if (pools.length < 2) throw new Error(`not enough pools (${errors.slice(0, 3).join("; ")})`);
    rt.pools.setPools(pools);
    await rt.pools.poll();
    if (errors.length) await this.event("warning", "market", `pool discovery: ${errors.length} source error(s)`, { errors: errors.slice(0, 10) });
    return pools.length;
  }

  private feeModel(): FeeModel {
    const rt = this.rt;
    return {
      computeUnits: (legs) => {
        const xs = this.cuSamples.get(legs) ?? [];
        return xs.length >= 5 ? Math.ceil(quantile(xs, 0.9) * 1.1) : 140_000 * legs + 40_000;
      },
      priorityFeeLamports: (profit, cu) =>
        choosePriorityFee({ market: rt.fees.latest(), basePercentile: rt.settings.strategy.priorityFeePercentile, computeUnits: cu, maxFeeLamports: rt.settings.risk.maxPriorityFeeLamports, expectedProfitLamports: profit, maxShareOfProfit: 0.3 }).totalLamports,
      jitoTipLamports: (profit) => rt.jito.tipLamports(profit, { percentile: rt.settings.strategy.jitoTipPercentile, maxTipLamports: rt.settings.risk.maxJitoTipLamports, maxShareOfProfit: rt.settings.risk.maxJitoTipShareOfProfit }),
      viaJito: () => rt.jitoEnabled,
    };
  }

  private async feesTick(): Promise<void> {
    const snap = await this.rt.fees.sample();
    if (this.rt.jitoEnabled && Date.now() - (this.rt.jitoClient.latestTipFloor()?.at ?? 0) > 30_000) await this.rt.jitoClient.refreshTipFloor().catch(() => undefined);
    if (Date.now() - this.lastFeePersistAt > 60_000) {
      this.lastFeePersistAt = Date.now();
      await this.rt.repo.insertPriorityFees(snap);
    }
  }

  // =============================================================================================
  // scanner loop
  // =============================================================================================
  private async scanTick(): Promise<void> {
    const rt = this.rt;
    const states = await rt.pools.poll();
    this.lastScanAt = Date.now();
    await this.publishMarkets();
    const s = rt.settings;
    const tradable = (m: string) => rt.tokens.isTradable(m);
    const all: Candidate[] = [];
    let screened = 0;
    for (const type of ["direct", "triangular"] as const) {
      const enabled = type === "direct" ? s.strategy.directEnabled : s.strategy.triangularEnabled;
      if (!enabled) continue;
      const r = screen(rt.pools.all(), { minNetSpreadBps: s.strategy.screenMinSpreadBps, direct: type === "direct", triangular: type === "triangular", maxSwaps: s.scanner.maxTriangularSwaps, tradable, now: Date.now() });
      this.noTrade.add("SPREAD_TOO_SMALL", type, r.stats.belowThreshold);
      screened += r.stats.pairsScreened;
      all.push(...r.candidates);
    }
    void states;
    all.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
    this.lastCandidates = all.slice(0, 50);
    this.screenedLog.push({ t: Date.now(), screened, candidates: all.length });
    while (this.screenedLog.length && (this.screenedLog[0] as { t: number }).t < Date.now() - 60_000) this.screenedLog.shift();
    this.queue.offer(all);

    const state = this.botState();
    if (state !== "PAPER" && state !== "SHADOW" && state !== "LIVE") return;
    const mode: TradeMode = state === "LIVE" ? "live" : "paper";
    if (rt.breakers.blocking(mode).length > 0) return; // nothing would pass the risk gate; keep the quote budget
    if (rt.fx.price() === null) return;
    const c = this.queue.next();
    if (!c) return;
    await this.handleCandidate(c, mode, state);
  }

  private liquidityDepthEur(c: Candidate, solEur: number): number | null {
    const rt = this.rt;
    const values: number[] = [];
    for (const h of c.hops) {
      const info = rt.pools.trackedPools.find((p) => p.address === h.pool);
      const st = rt.pools.get(h.pool);
      if (!info || !st) continue;
      const d = rt.registry.get(info.dex)?.getLiquidity(info, st).depth1pctA ?? null;
      if (d === null) continue;
      if (info.mintA === SOL_MINT) values.push(d);
      else if (info.mintB === SOL_MINT) values.push(d * st.priceAInB);
    }
    return values.length ? Math.min(...values) * solEur : null;
  }

  private riskContext(mode: TradeMode, solEur: number, tokenMint: string, depthEur: number | null): RiskContext {
    const rt = this.rt;
    const p = mode === "live" ? this.live : this.paper;
    return {
      now: Date.now(),
      mode,
      settings: rt.settings,
      botState: this.botState(),
      liveGate: this.gateRecord().state,
      liveModeEnabled: rt.config.liveMode,
      emergencyStop: this.emergency().active,
      blockingBreakers: rt.breakers.blocking(mode),
      solEur,
      balanceLamports: mode === "live" ? (rt.wallet.lamports ?? 0n) : p.balanceLamports,
      capitalEur: lamportsToEur(mode === "live" ? (rt.wallet.lamports ?? 0n) : p.balanceLamports, solEur),
      openTrades: p.openTrades,
      pnlTodayEur: p.pnlTodayEur(),
      consecutiveFailures: p.consecutiveFailures,
      lossStreak: p.lossStreak,
      lastTradeSizeEur: p.lastTradeSizeEur,
      lastTradeLost: p.lastTradeLost,
      drawdownEur: p.drawdownEur(),
      expectancyEur: p.expectancyEur(),
      token: rt.tokens.get(tokenMint),
      liquidityDepthEur: depthEur,
      viaJito: rt.jitoEnabled,
    };
  }

  private async handleCandidate(c: Candidate, mode: TradeMode, state: BotState): Promise<void> {
    const rt = this.rt;
    const solEur = rt.fx.price() as number;
    const depthEur = this.liquidityDepthEur(c, solEur);
    const ctx0 = this.riskContext(mode, solEur, c.tokenMint, depthEur);
    const cap = rt.risk.sizeCap(ctx0);
    const rentEstimate = c.route.slice(1, -1).filter((m) => !rt.wallet.hasTokenAccount(m)).length * 2_039_280;
    const rentEur = lamportsToEur(BigInt(rentEstimate), solEur);
    const evalCtx: EvaluationContext = {
      mode,
      settings: rt.settings,
      solEur,
      sizeCapEur: Math.max(0, cap.capEur - rentEur),
      strategyVersionId: this.strategyVersionId,
      rentLockedLamports: BigInt(rentEstimate),
      poolStateAgeMs: Date.now() - c.oldestStateAt,
      volatilityBps: Math.abs(rt.fx.changeOver(300_000) ?? 0) * 10_000,
      decimals: (m) => rt.tokens.decimals(m),
      now: Date.now,
    };
    const { opportunity: o } = await this.evaluator.evaluate(c, evalCtx);
    this.queue.feedback(c.key, c.netSpreadBps, o.legs.length ? o.grossProfitPercent * 100 : null);
    const features = this.evaluator.features(c, evalCtx, o.sizeEur, o.grossProfitPercent * 100, o.quoteAge);
    await rt.repo.insertOpportunity(o, features);
    await rt.repo.insertQuotes(o.legs, o.id, "verify");
    if (mode === "paper") rt.learning.countOpportunity();
    if (o.status !== "EXECUTABLE") {
      this.remember(o);
      await rt.bus.publishEvent("OPPORTUNITY_REJECTED", this.row(o));
      return;
    }

    // RISK GATE — the only way to an execution
    const decision = rt.risk.validate(o, this.riskContext(mode, solEur, c.tokenMint, depthEur));
    if (!decision.allowed || !decision.approval) {
      const reason = decision.codes[0] ?? "RISK_LIMIT";
      o.status = "REJECTED";
      o.rejectionReason = reason;
      o.rejectionDetail = decision.reasons.join("; ");
      await rt.repo.updateOpportunityStatus(o.id, o.timestamp, "REJECTED", reason, o.rejectionDetail);
      this.remember(o);
      await rt.bus.publishEvent("OPPORTUNITY_REJECTED", this.row(o));
      if (reason === "DAILY_LOSS_LIMIT" || reason === "RISK_LIMIT") {
        await rt.notifications.notify({ type: reason === "DAILY_LOSS_LIMIT" ? "DAILY_LIMIT" : "RISK_LIMIT", severity: "warning", title: reason === "DAILY_LOSS_LIMIT" ? "Daily loss limit" : "Risk limit", message: o.rejectionDetail ?? reason });
      }
      return;
    }
    this.remember(o);
    await rt.bus.publishEvent("OPPORTUNITY_DETECTED", this.row(o));
    await rt.notifications.notify({ type: "OPPORTUNITY_DETECTED", severity: "info", title: `${o.strategyType} ${this.routeLabel(o)}`, message: `expected net ${o.expectedNetProfitEur.toFixed(4)} € at ${o.sizeEur.toFixed(2)} € (${mode})` });

    if (mode === "paper") {
      if (!rt.config.paperMode) return;
      await this.executePaper(o, decision.approval, features, c.key, state === "SHADOW");
    } else {
      await this.executeLive(o, decision.approval, features, c.key);
    }
  }

  // =============================================================================================
  // execution
  // =============================================================================================
  private async executePaper(o: Opportunity, approval: NonNullable<ReturnType<Runtime["risk"]["validate"]>["approval"]>, features: ExecutionFeatures, routeKey: string, shadow: boolean): Promise<void> {
    const rt = this.rt;
    await rt.bus.publishEvent("PAPER_TRADE_CREATED", { opportunityId: o.id, shadow, sizeEur: o.sizeEur, route: this.routeLabel(o) });
    const rec = await rt.paperExecutor(shadow).execute(o, approval, this.paper);
    const sample = this.sampleFromPaper(o, features, routeKey, rec);
    await rt.repo.insertPaperTrade(rec, sample);
    await rt.repo.updateOpportunityStatus(o.id, o.timestamp, rec.success ? "SIMULATED" : "FAILED", null, rec.failureReason);
    if (rec.simulation?.unitsConsumed) this.cuSample(o.legs.length, rec.simulation.unitsConsumed);
    if (sample) {
      rt.learning.ingest(sample);
      if (sample.realizedSlippageBps !== null) this.pushDeviation(sample.realizedSlippageBps - sample.predictedSlippageBps);
    }
    const r = this.recent.find((x) => x.id === o.id);
    if (r) r.status = rec.success === true ? "PAPER_WIN" : rec.success === false ? "PAPER_FAILED" : "UNKNOWN";
    await rt.bus.publishEvent("PAPER_TRADE_CLOSED", { id: rec.id, opportunityId: o.id, success: rec.success, realizedNetEur: rec.realizedNetEur, predictedNet: rec.predictedNet, failureReason: rec.failureReason, shadow });
    await rt.bus.publishEvent("P&L_UPDATED", { mode: "paper", portfolio: this.paper.snapshot(o.solEur) });
  }

  private sampleFromPaper(o: Opportunity, features: ExecutionFeatures, routeKey: string, rec: PaperTradeRecord): LearningSample | null {
    if (rec.success === null) return null;
    const requoteAt = rec.stages.find((s) => s.stage === "REQUOTE")?.at ?? rec.tsClosed;
    const fees = Number(BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee + o.jitoTip);
    return {
      ts: rec.tsClosed,
      mode: rec.shadow ? "shadow" : "paper",
      routeKey,
      features,
      predictedP: o.executionProbability,
      success: rec.success,
      inputLamports: Number(o.inputAmount),
      predictedNetLamports: Number(o.expectedNetProfit),
      realizedNetLamports: Number(rec.realizedNet),
      predictedSlippageBps: bps(o.expectedSlippage, o.inputAmount),
      realizedSlippageBps: rec.slippageLamports === null ? null : bps(rec.slippageLamports, o.inputAmount),
      latencyMs: Math.max(0, requoteAt - o.timestamp),
      predictedFeesLamports: fees,
      actualFeesLamports: rec.fees.paid ? fees : 0,
      solEur: o.solEur,
      usableEdgeBps: o.costs?.usableEdgeBps ?? 0,
      usableEdgeEur: o.expectedNetProfitEur,
    };
  }

  private async executeLive(o: Opportunity, approval: NonNullable<ReturnType<Runtime["risk"]["validate"]>["approval"]>, features: ExecutionFeatures, routeKey: string): Promise<void> {
    const rt = this.rt;
    const level = rt.settings.risk.liveLevel;
    await rt.bus.publishEvent("LIVE_TRADE_CREATED", { opportunityId: o.id, sizeEur: o.sizeEur, route: this.routeLabel(o), level });
    const rec = await rt.liveExecutor.execute(o, approval, this.live);
    const guard = closingGuard(o, rt.settings.strategy.minNetProfitEur);
    const minOut = guard ? minOutForSlippage(o.outputAmount, guard.slippageBps) : 0n;
    const sample = this.sampleFromLive(o, features, routeKey, rec);
    await rt.repo.insertLiveTrade(rec, o, level, minOut, sample);
    await rt.repo.updateOpportunityStatus(o.id, o.timestamp, rec.outcome === "CONFIRMED" ? "CONFIRMED" : rec.outcome === "CANCELLED" ? "REJECTED" : "FAILED", rec.outcome === "CANCELLED" ? "OPPORTUNITY_VANISHED" : null, rec.reason);
    const row = this.recent.find((x) => x.id === o.id);
    if (row) row.status = `LIVE_${rec.outcome}`;
    if (rec.unitsConsumed) this.cuSample(o.legs.length, rec.unitsConsumed);
    if (rec.signature && rec.outcome !== "CANCELLED") await rt.bus.publishEvent("TRANSACTION_SUBMITTED", { signature: rec.signature, bundleId: rec.bundleId });

    if (rec.outcome === "CONFIRMED" || rec.outcome === "FAILED") {
      const failed = rec.outcome === "FAILED";
      this.recentTxFailures.push(failed);
      if (this.recentTxFailures.length > 20) this.recentTxFailures.shift();
      if (sample) {
        rt.learning.ingest(sample);
        if (sample.realizedSlippageBps !== null) this.pushDeviation(sample.realizedSlippageBps - sample.predictedSlippageBps);
      }
      await rt.bus.publishEvent(failed ? "TRANSACTION_FAILED" : "TRANSACTION_CONFIRMED", { signature: rec.signature, slot: rec.slot, realizedNetEur: rec.realizedNetEur, reason: rec.reason });
      await rt.notifications.notify({
        type: failed ? "TRADE_FAILED" : "TRADE_EXECUTED",
        severity: failed ? "error" : (rec.realizedNetEur ?? 0) >= 0 ? "success" : "warning",
        title: failed ? "Live trade failed" : "Live trade executed",
        message: `${this.routeLabel(o)} ${o.sizeEur.toFixed(2)} € → ${(rec.realizedNetEur ?? 0).toFixed(4)} € (${rec.signature ?? "no signature"})`,
      });
      if ((rec.realizedNetEur ?? 0) < -rt.settings.risk.maxLossPerTradeEur / 2) {
        await rt.notifications.notify({ type: "LARGE_LOSS", severity: "critical", title: "Large loss", message: `${(rec.realizedNetEur ?? 0).toFixed(4)} € on ${rec.signature}` });
      }
      if (rec.outcome === "CONFIRMED" && rec.signature && rec.realizedNet !== null && rt.wallet.address) await this.recordTax(o, rec);
      await this.updateLevelStats(o, rec);
      await this.walletTick().catch(() => undefined);
    }
    await rt.bus.publishEvent("LIVE_TRADE_CLOSED", { id: rec.id, outcome: rec.outcome, reason: rec.reason, realizedNetEur: rec.realizedNetEur, signature: rec.signature });
    await rt.bus.publishEvent("P&L_UPDATED", { mode: "live", portfolio: this.live.snapshot(o.solEur) });
  }

  private sampleFromLive(o: Opportunity, features: ExecutionFeatures, routeKey: string, rec: LiveTradeRecord): LearningSample | null {
    if (rec.outcome !== "CONFIRMED" && rec.outcome !== "FAILED") return null;
    const realized = rec.realizedNet ?? 0n;
    const predictedFees = Number(BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee + o.jitoTip);
    const grossRealized = realized + BigInt(predictedFees);
    return {
      ts: rec.tsConfirmed ?? Date.now(),
      mode: "live",
      routeKey,
      features,
      predictedP: o.executionProbability,
      success: rec.outcome === "CONFIRMED",
      inputLamports: Number(o.inputAmount),
      predictedNetLamports: Number(o.expectedNetProfit),
      realizedNetLamports: Number(realized),
      predictedSlippageBps: bps(o.expectedSlippage, o.inputAmount),
      realizedSlippageBps: rec.outcome === "CONFIRMED" ? bps(o.grossProfit - grossRealized, o.inputAmount) : null,
      latencyMs: rec.tsConfirmed && rec.tsSubmitted ? rec.tsConfirmed - o.timestamp : 0,
      predictedFeesLamports: predictedFees,
      actualFeesLamports: Number(rec.feesPaid ?? 0n),
      solEur: o.solEur,
      usableEdgeBps: o.costs?.usableEdgeBps ?? 0,
      usableEdgeEur: o.expectedNetProfitEur,
    };
  }

  private async recordTax(o: Opportunity, rec: LiveTradeRecord): Promise<void> {
    const rt = this.rt;
    const fees = rec.feesPaid ?? 0n;
    const realizedSolDelta = (rec.realizedNet ?? 0n) - rec.rentLocked;
    // SOL that came back = input + wallet delta + fees paid (the delta already contains the fees)
    const output = o.inputAmount + realizedSolDelta + fees + rec.rentLocked;
    const rows = rt.tax.recordArbitrage({
      ts: rec.tsConfirmed ?? Date.now(),
      signature: rec.signature as string,
      wallet: rt.wallet.address as string,
      liveTradeId: rec.id,
      solEur: rt.fx.price() ?? o.solEur,
      solEurTs: rt.fx.latest?.ts ?? Date.now(),
      route: o.route,
      dexes: o.routeDexes,
      decimals: (m) => rt.tokens.decimals(m) ?? 0,
      inputLamports: o.inputAmount,
      outputLamports: output,
      intermediateAmounts: o.legs.slice(0, -1).map((l) => l.outputAmount),
      feesLamports: fees,
    });
    await rt.repo.saveTax(rows, rt.tax.book.dirty());
  }

  private async updateLevelStats(o: Opportunity, rec: LiveTradeRecord): Promise<void> {
    const rt = this.rt;
    const st = this.levelStats;
    st.attempts++;
    if (rec.outcome === "FAILED") {
      st.failures++;
      st.consecutiveFailures++;
    } else st.consecutiveFailures = 0;
    st.netEur.push(rec.realizedNetEur ?? 0);
    const cum = st.netEur.reduce((acc, x) => {
      const c = (acc.at(-1) ?? 0) + x;
      acc.push(c);
      return acc;
    }, [] as number[]);
    let peak = 0;
    st.drawdownEur = 0;
    for (const c of cum) {
      peak = Math.max(peak, c);
      st.drawdownEur = Math.max(st.drawdownEur, peak - c);
    }
    if (rec.realizedNet !== null) st.devBps.push(bps(rec.realizedNet - o.expectedNetProfit, o.inputAmount));
    st.liveVsPaperBps = st.devBps.length >= 5 ? mean(st.devBps) : null;

    const action = evaluateLiveLevel(st.level as LiveLevel, st, rt.settings);
    if (action.action === "downgrade") {
      const next = mergeSettings(rt.settings, { risk: { liveLevel: action.level } });
      if (isRiskNotIncreased(rt.settings, next)) {
        await rt.store.update({ risk: { liveLevel: action.level } }, "system:auto-downgrade");
        await rt.repo.riskEvent("downgrade", "warning", `live level ${st.level} → ${action.level}: ${action.reason}`, { mode: "live" });
        await rt.notifications.notify({ type: "RISK_LIMIT", severity: "warning", title: "Live level lowered", message: `Level ${st.level} → ${action.level}: ${action.reason}` });
      }
    } else if (action.action === "stop_live") {
      await this.stopLive(action.reason);
    }
    const elig = levelUpEligibility(st.level as LiveLevel, st, rt.settings);
    await rt.store.setState(STATE_KEYS.levelEligibility, { ...elig, level: st.level, at: Date.now() });
  }

  /** Automatic risk reduction: live off, back to paper. Re-enabling needs the user again. */
  private async stopLive(reason: string): Promise<void> {
    const rt = this.rt;
    const g = this.gateRecord();
    await rt.store.setState(STATE_KEYS.liveGate, { ...g, state: "LIVE_LOCKED", stoppedReason: reason } satisfies LiveGateRecord);
    await rt.repo.riskEvent("live_pause", "critical", `live trading stopped: ${reason}`, { mode: "live" });
    await rt.notifications.notify({ type: "RISK_LIMIT", severity: "critical", title: "Live trading stopped — back to PAPER", message: reason });
    await this.event("critical", "risk", `live trading stopped: ${reason}`);
  }

  private cuSample(legs: number, units: number): void {
    const xs = this.cuSamples.get(legs) ?? [];
    xs.push(units);
    if (xs.length > 200) xs.shift();
    this.cuSamples.set(legs, xs);
  }

  private pushDeviation(d: number): void {
    this.slippageDeviations.push(d);
    if (this.slippageDeviations.length > 20) this.slippageDeviations.shift();
  }

  // =============================================================================================
  // breakers, wallet, learning, optimizer
  // =============================================================================================
  private async breakerTick(): Promise<void> {
    const rt = this.rt;
    const eps = rt.rpc.endpointHealth();
    const healthy = eps.filter((e) => e.status === "CONNECTED" || e.status === "DEGRADED");
    const dbOk = await rt.db.ping();
    evaluateBreakers(rt.breakers, {
      rpcHealthy: healthy.length > 0,
      rpcLatencyMs: healthy.length ? Math.min(...healthy.map((e) => e.latencyMs ?? 0)) : null,
      quoteProviderAvailable: rt.jupiter.available().ok,
      poolStateAgeMs: rt.pools.maxAgeMs(),
      poolPollMs: rt.settings.scanner.poolPollMs,
      dexUnavailable: rt.registry.all().filter((a) => !a.available().ok).map((a) => a.id),
      solEurChange5mPct: rt.fx.changeOver(300_000) === null ? null : (rt.fx.changeOver(300_000) as number) * 100,
      slippageDeviationsBps: this.slippageDeviations,
      recentTxFailures: this.recentTxFailures,
      jitoHealthy: rt.jitoEnabled ? rt.jito.available().ok : null,
      databaseHealthy: dbOk,
      redisHealthy: rt.bus.isHealthy,
      walletMatches: this.walletMatches,
      balanceMatches: this.balanceMatch,
    });
  }

  private async onBreakerChange(id: CircuitBreakerId, open: boolean, reason: string | null, by: string): Promise<void> {
    const rt = this.rt;
    const liveOnly = LIVE_ONLY_BREAKERS_SET.has(id);
    await rt.store.setState(STATE_KEYS.breakers, rt.breakers.snapshot()).catch(() => undefined);
    await rt.repo.riskEvent(open ? "breaker_open" : "breaker_close", open ? "error" : "info", open ? `${id} opened: ${reason}` : `${id} closed (${by})`, { breaker: id, mode: liveOnly ? "live" : null }).catch(() => undefined);
    await rt.bus.publishEvent("RISK_TRIGGERED", { breaker: id, open, reason, by });
    if (open) {
      const type = id === "RPC_OUTAGE" ? "RPC_OUTAGE" : id === "QUOTE_OUTAGE" || id === "DEX_OUTAGE" ? "QUOTE_PROVIDER_ERROR" : id === "JITO_PROBLEM" ? "JITO_ERROR" : "RISK_LIMIT";
      await rt.notifications.notify({ type, severity: liveOnly ? "critical" : "error", title: `Circuit breaker: ${id}`, message: reason ?? id }).catch(() => undefined);
    }
  }

  private async checkWalletIdentity(): Promise<void> {
    const rt = this.rt;
    const addr = rt.wallet.address;
    if (!addr) return;
    const recorded = rt.store.getState<string | null>(STATE_KEYS.walletAddress, null);
    if (!recorded) {
      await rt.store.setState(STATE_KEYS.walletAddress, addr);
      this.walletMatches = true;
    } else this.walletMatches = recorded === addr;
  }

  private async walletTick(): Promise<void> {
    const rt = this.rt;
    if (!rt.wallet.configured || !rt.wallet.address) return;
    const before = rt.wallet.lamports;
    await rt.wallet.refresh();
    const now = rt.wallet.lamports as bigint;
    this.live.balanceLamports = now;
    await rt.repo.upsertWallet(rt.wallet.address, now, rt.wallet.status().holdings);
    if (before !== null && before !== now) await rt.bus.publishEvent("WALLET_UPDATED", rt.wallet.status());
    // reconciliation: on-chain balance vs baseline + recorded live results
    const base = await rt.repo.lastBalanceBaseline(rt.wallet.address);
    if (!base) {
      await rt.repo.balanceCheck(rt.wallet.address, now, now, true, "baseline");
      this.balanceMatch = true;
      return;
    }
    if (this.live.openTrades > 0 || rt.liveExecutor.busy) return;
    const expected = base.lamports + (await rt.repo.liveDeltaSince(base.ts));
    const ok = balancesMatch(now, expected);
    if (!ok || Date.now() - base.ts > 600_000) await rt.repo.balanceCheck(rt.wallet.address, now, expected, ok, ok ? null : "on-chain balance differs from recorded live results (deposit/withdrawal?)");
    if (!ok && this.balanceMatch !== false) await rt.notifications.notify({ type: "WALLET_CHANGE", severity: "warning", title: "Wallet balance changed", message: `on-chain ${now} lamports, expected ${expected} — confirm by resetting BALANCE_MISMATCH` });
    this.balanceMatch = ok;
  }

  private async learningTick(): Promise<void> {
    const rt = this.rt;
    const snap = rt.learning.snapshot();
    const g = this.gateRecord();
    if (g.state === "LIVE_LOCKED" && snap.gate.ready) {
      await rt.store.setState(STATE_KEYS.liveGate, { ...g, state: "LIVE_READY", readyAt: Date.now() } satisfies LiveGateRecord);
      await rt.notifications.notify({ type: "LIVE_UNLOCK", severity: "success", title: "LIVE READY", message: "Validation passed. Live trading stays OFF until you confirm \"ENABLE LIVE TRADING\"." });
      await rt.repo.learningMetric("gate", snap.gate, this.strategyVersionId);
    } else if (g.state === "LIVE_READY" && !snap.gate.ready) {
      await rt.store.setState(STATE_KEYS.liveGate, { ...g, state: "LIVE_LOCKED" } satisfies LiveGateRecord);
    } else if (g.state === "LIVE_ENABLED" && snap.status === "DEGRADED") {
      await this.stopLive("learning status DEGRADED (out-of-sample expectancy ≤ 0)");
    }
    await rt.bus.setJson(KEY_WORKER_LEARNING, { ...snap, strategyVersionId: this.strategyVersionId }, 300);
    await rt.bus.publishEvent("LEARNING_UPDATED", { score: snap.score, status: snap.status, samples: snap.samples, gateReady: snap.gate.ready });
    if (Date.now() - this.lastLearningMetricAt > 300_000) {
      this.lastLearningMetricAt = Date.now();
      await rt.repo.learningMetric("score", { score: snap.score, status: snap.status, samples: snap.samples, counts: snap.counts, successRate: snap.successRate, latencyMs: snap.latencyMs, expectedSlippageBps: snap.expectedSlippageBps }, this.strategyVersionId);
      if (snap.report) await rt.repo.learningMetric("oos", { oos: snap.report.oos, validation: snap.report.validation, walkForward: snap.report.walkForward, stable: snap.report.stable }, this.strategyVersionId);
    }
  }

  async optimizerTick(): Promise<void> {
    const rt = this.rt;
    if (!this.strategyVersionId) return;
    const current = this.strategyVersionId;
    // 1) rollback check of the active version against its parent
    const v = await rt.repo.version(current);
    if (v?.parent_id) {
      const rb = shouldRollback(await rt.repo.paperNetByVersion(current), await rt.repo.paperNetByVersion(v.parent_id));
      if (rb.rollback) {
        const params = await rt.repo.versionParams(v.parent_id);
        const patch = Object.fromEntries(Object.entries(params).filter(([k]) => (SELF_TUNABLE_STRATEGY_KEYS as readonly string[]).includes(k)));
        await rt.store.update({ strategy: patch }, "system:rollback");
        await rt.repo.setVersionStatus(current, "rolled_back", rb.reason);
        await rt.repo.setVersionStatus(v.parent_id, "active");
        this.strategyVersionId = v.parent_id;
        await rt.store.setState(STATE_KEYS.activeStrategy, v.parent_id);
        await rt.repo.riskEvent("rollback", "warning", `${current} rolled back to ${v.parent_id}: ${rb.reason}`);
        await rt.notifications.notify({ type: "LEARNING_MILESTONE", severity: "warning", title: "Strategy rolled back", message: `${current} → ${v.parent_id}: ${rb.reason}` });
        return;
      }
    }
    // 2) threshold optimisation (stricter only, validated chronologically)
    const samples = rt.learning.allSamples().filter((s) => s.mode !== "live");
    const res = optimizeThresholds(samples, rt.settings.strategy, rt.settings.learning.splits);
    await rt.repo.learningMetric("optimizer", { reason: res.reason, proposal: res.proposal, current: res.current, candidate: res.candidate, evaluated: res.evaluated }, current);
    if (!res.proposal) return;
    const nextSettings = mergeSettings(rt.settings, { strategy: res.proposal });
    if (!isRiskNotIncreased(rt.settings, nextSettings)) return;
    const n = await rt.repo.nextVersionNumber();
    const id = await rt.repo.createVersion(n, current, nextSettings.strategy, "optimizer", res.reason, "active", res.candidate);
    await rt.repo.setVersionStatus(current, "retired");
    await rt.store.update({ strategy: res.proposal }, "system:optimizer");
    this.strategyVersionId = id;
    await rt.store.setState(STATE_KEYS.activeStrategy, id);
    await this.event("success", "learning", `new strategy version ${id}: ${res.reason}`, res.proposal);
    await rt.notifications.notify({ type: "LEARNING_MILESTONE", severity: "success", title: `Strategy ${id}`, message: res.reason });
  }

  // =============================================================================================
  // control commands (the database is the source of truth; the message only says "re-read")
  // =============================================================================================
  private onControl(cmd: ControlCommand): void {
    this.controlChain = this.controlChain.then(() => this.handleControl(cmd)).catch((err) => this.log.error({ err, cmd: cmd.type }, "control command failed"));
  }

  /** The paper account of the current epoch: its start balance plus the trades closed since. */
  private async loadPaperEpoch(start: PaperStartRecord): Promise<void> {
    const paper = new Portfolio("paper", BigInt(start.lamports));
    paper.restore((await this.rt.repo.loadClosedTrades("paper")).filter((t) => t.closedAt >= start.at));
    this.paper = paper;
    this.paperEpochAt = start.at;
  }

  private async handleControl(cmd: ControlCommand): Promise<void> {
    const rt = this.rt;
    if (!this.ready) return;
    await rt.store.reloadState();
    await rt.store.refresh();
    this.log.info({ cmd: cmd.type, state: this.botState() }, "control command");
    switch (cmd.type) {
      case "EMERGENCY_STOP":
        await rt.repo.riskEvent("emergency_stop", "critical", `EMERGENCY STOP: ${cmd.reason}`);
        await rt.notifications.notify({ type: "EMERGENCY_STOP", severity: "critical", title: "EMERGENCY STOP", message: cmd.reason });
        await this.event("critical", "control", `EMERGENCY STOP: ${cmd.reason}`);
        break;
      case "EMERGENCY_RELEASE":
        await rt.repo.riskEvent("emergency_release", "warning", "emergency stop released by the user");
        break;
      case "BREAKER_RESET":
        if (rt.breakers.reset(cmd.breaker, cmd.actor)) {
          if (cmd.breaker === "BALANCE_MISMATCH" && rt.wallet.address && rt.wallet.lamports !== null) {
            await rt.repo.balanceCheck(rt.wallet.address, rt.wallet.lamports, rt.wallet.lamports, true, `re-baselined by ${cmd.actor}`);
            this.balanceMatch = true;
          }
          if (cmd.breaker === "WALLET_MISMATCH" && rt.wallet.address) {
            await rt.store.setState(STATE_KEYS.walletAddress, rt.wallet.address);
            this.walletMatches = true;
          }
          if (cmd.breaker === "UNEXPECTED_SLIPPAGE") this.slippageDeviations.length = 0;
          if (cmd.breaker === "TX_FAILURE_SPIKE") this.recentTxFailures.length = 0;
        }
        break;
      case "RUN_OPTIMIZATION":
        await this.optimizerTick();
        break;
      case "REFRESH_WALLET":
        await this.walletTick();
        break;
      case "PAPER_RESET": {
        const start = rt.store.getState<PaperStartRecord | null>(STATE_KEYS.paperStart, null);
        if (start && start.at !== this.paperEpochAt) await this.loadPaperEpoch(start);
        await this.event("info", "paper", `paper account restarted with ${cmd.capitalEur} € by ${cmd.actor}`, { capitalEur: cmd.capitalEur });
        break;
      }
      case "LIVE_ENABLE":
        await rt.repo.riskEvent("live_enable", "warning", `live trading enabled by ${cmd.actor} (level ${rt.settings.risk.liveLevel})`, { mode: "live" });
        await rt.notifications.notify({ type: "LIVE_UNLOCK", severity: "warning", title: "LIVE TRADING ENABLED", message: `by ${cmd.actor}, level ${rt.settings.risk.liveLevel}` });
        break;
      default:
        break;
    }
    await this.publishStatus();
  }

  // =============================================================================================
  // status for the API / UI
  // =============================================================================================
  private routeLabel(o: Pick<Opportunity, "route" | "routeDexes">): string {
    return `${o.route.map((m) => symbolOf(this.rt, m)).join("→")} [${o.routeDexes.join("→")}]`;
  }

  private row(o: Opportunity): ScannerRow {
    return {
      id: o.id,
      ts: o.timestamp,
      type: o.strategyType,
      route: o.route.map((m) => symbolOf(this.rt, m)),
      dexes: o.routeDexes,
      sizeEur: o.sizeEur,
      grossBps: o.grossProfitPercent * 100,
      netEur: o.expectedNetProfitEur,
      netBps: o.expectedNetProfitPercent * 100,
      probability: o.executionProbability,
      quoteAgeMs: o.quoteAge,
      status: o.status,
      reason: o.rejectionReason,
      detail: o.rejectionDetail,
    };
  }

  private remember(o: Opportunity): void {
    this.recent.unshift(this.row(o));
    if (this.recent.length > 100) this.recent.pop();
  }

  private async publishMarkets(): Promise<void> {
    const rt = this.rt;
    const now = Date.now();
    const markets = rt.pools.trackedPools.map((p) => {
      const st = rt.pools.get(p.address);
      return {
        pool: p.address,
        dex: p.dex,
        kind: p.kind,
        label: p.label,
        pair: `${symbolOf(rt, p.mintA)}/${symbolOf(rt, p.mintB)}`,
        mintA: p.mintA,
        mintB: p.mintB,
        price: st?.priceAInB ?? null,
        feeBps: (st?.feeRate ?? p.feeRate) * 10_000,
        tvlUsd: p.tvlUsd,
        slot: st?.slot ?? null,
        ageMs: st ? now - st.fetchedAt : null,
        active: st?.active ?? false,
      };
    });
    await rt.bus.setJson(KEY_MARKETS, { ts: now, slot: rt.pools.lastSlot, markets }, 60);
    await rt.bus.setJson(
      KEY_SCANNER_TABLE,
      {
        ts: now,
        candidates: this.lastCandidates.map((c) => ({ key: c.key, type: c.strategyType, route: c.route.map((m) => symbolOf(rt, m)), dexes: c.dexes, midSpreadBps: c.midSpreadBps, netSpreadBps: c.netSpreadBps, slot: c.slot, ageMs: now - c.oldestStateAt })),
        opportunities: this.recent,
        queue: { pending: this.queue.size(), remainingThisMinute: this.queue.remaining(), backedOff: this.queue.backedOff() },
      },
      60,
    );
  }

  async publishStatus(): Promise<void> {
    const rt = this.rt;
    if (!rt.bus.isHealthy) {
      try {
        await rt.bus.connect();
      } catch {
        return;
      }
    }
    const solEur = rt.fx.price(600_000);
    const m = processMetrics();
    const snap = this.ready ? rt.learning.snapshot() : null;
    const status: WorkerStatus = {
      ts: Date.now(),
      botState: this.botState(),
      liveGate: this.ready ? this.gateRecord().state : "LIVE_LOCKED",
      liveEnvAllowed: rt.config.liveMode,
      shadow: this.ready ? this.shadow() : false,
      ready: this.ready,
      notReadyReasons: this.notReadyReasons,
      startedAt: this.startedAt,
      components: [
        { name: "database", status: rt.db.isHealthy ? "CONNECTED" : "DISCONNECTED" },
        { name: "redis", status: rt.bus.isHealthy ? "CONNECTED" : "DISCONNECTED", lastError: rt.bus.lastError },
        { name: "solana_rpc", status: rt.rpc.componentStatus(), detail: rt.rpc.healthDetail() },
        { name: "jupiter", status: rt.jupiter.available().ok ? (rt.jupiter.lastOkAt ? "CONNECTED" : "UNKNOWN") : "DISCONNECTED", lastError: rt.jupiter.lastError },
        ...rt.registry.all().filter((a) => a.id !== "jupiter").map((a) => ({ name: a.id, status: (a.available().ok ? "CONNECTED" : "DISCONNECTED") as "CONNECTED" | "DISCONNECTED", detail: `${rt.pools.trackedPools.filter((p) => p.dex === a.id).length} pools` })),
        { name: "jito", status: !rt.jitoEnabled ? "DISABLED" : rt.jito.available().ok ? (rt.jitoClient.lastOkAt ? "CONNECTED" : "UNKNOWN") : "DISCONNECTED", lastError: rt.jitoClient.lastError },
        { name: "sol_eur", status: solEur ? "CONNECTED" : "DISCONNECTED", lastError: rt.fx.lastError },
        { name: "wallet", status: rt.wallet.configured ? "CONNECTED" : "DISABLED", detail: rt.wallet.loadError ?? undefined },
      ],
      breakers: rt.breakers.snapshot().map((b) => ({ id: b.id, open: b.open, since: b.openedAt, reason: b.reason, liveOnly: LIVE_ONLY_BREAKERS_SET.has(b.id) })),
      solEur,
      solEurAt: rt.fx.latest?.ts ?? null,
      slot: rt.pools.lastSlot,
      quoteBudget: { rps: rt.jupiter.budget.rps, ...rt.jupiter.budget.usage() },
      scanner: {
        pools: rt.pools.trackedPools.length,
        tokens: rt.tokens.safe().length,
        lastScanAt: this.lastScanAt,
        candidates1m: this.screenedLog.reduce((a, x) => a + x.candidates, 0),
        screened1m: this.screenedLog.reduce((a, x) => a + x.screened, 0),
      },
      learning: { score: snap?.score ?? 0, status: snap?.status ?? "COLLECTING_DATA" },
      wallet: { configured: rt.wallet.configured, address: rt.wallet.address, balanceLamports: rt.wallet.lamports?.toString() ?? null },
      metrics: { cpuPct: m.cpuPct, rssMb: m.rssMb, heapMb: m.heapMb, eventLoopLagMs: m.eventLoopLagMs },
    };
    await rt.bus.setJson(KEY_WORKER_STATUS, status, 15);
    await rt.bus.setJson(KEY_WORKER_HEARTBEAT, { ts: status.ts, botState: status.botState }, 15);
    await rt.bus.publishEvent("STATUS_UPDATED", status);
    if (!this.ready || !solEur) return;
    const ctxPaper = this.riskContext("paper", solEur, SOL_MINT, null);
    const ctxLive = this.riskContext("live", solEur, SOL_MINT, null);
    await rt.bus.setJson(KEY_WORKER_PORTFOLIO, { ts: status.ts, solEur, paper: this.paper.snapshot(solEur), live: this.live.snapshot(solEur), paperStart: rt.store.getState(STATE_KEYS.paperStart, null) }, 60);
    await rt.bus.setJson(
      KEY_WORKER_RISK,
      {
        ts: status.ts,
        sizeCap: { paper: rt.risk.sizeCap(ctxPaper), live: rt.risk.sizeCap(ctxLive) },
        scalingSuggestion: scalingSuggestion(ctxLive.capitalEur || ctxPaper.capitalEur, rt.settings),
        limits: {
          paper: { pnlTodayEur: ctxPaper.pnlTodayEur, dailyLossLimitEur: rt.settings.risk.dailyLossLimitEur, consecutiveFailures: ctxPaper.consecutiveFailures, maxConsecutiveFailures: rt.settings.risk.maxConsecutiveFailures, openTrades: ctxPaper.openTrades },
          live: { pnlTodayEur: ctxLive.pnlTodayEur, dailyLossLimitEur: rt.settings.risk.dailyLossLimitEur, consecutiveFailures: ctxLive.consecutiveFailures, maxConsecutiveFailures: rt.settings.risk.maxConsecutiveFailures, openTrades: ctxLive.openTrades },
        },
        liveLevel: rt.settings.risk.liveLevel,
        levelStats: { ...this.levelStats },
        levelEligibility: rt.store.getState(STATE_KEYS.levelEligibility, null),
        liveGate: this.gateRecord(),
        emergency: this.emergency(),
        control: this.control(),
        strategyVersionId: this.strategyVersionId,
        jitoTipFloor: rt.jitoClient.latestTipFloor(),
        priorityFees: rt.fees.latest(),
      },
      60,
    );
  }

  private async event(level: string, category: string, message: string, data?: unknown): Promise<void> {
    await this.rt.repo.systemEvent(level, category, message, data).catch(() => undefined);
    await this.rt.bus.publishEvent("LOG", { level, category, message, ts: Date.now() });
  }
}
