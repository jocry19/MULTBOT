import type { ActivityLevel, Settings } from "@multbot/shared";
import type { Logger } from "pino";
import { systemClock, type Clock } from "../../core/clock.js";
import { BaseModule, type ModuleHealth } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import { BacktestRunner } from "../backtest/backtestRunner.js";
import { DiscoveryRunner } from "../discovery/discoveryRunner.js";
import { StrategyService } from "../strategy/strategyService.js";
import { OutcomeLabeler } from "./labeler.js";
import { AnalogueIndex, clusterSituations, type AnalogueResult, type SituationSample } from "./situations.js";
import type { SampleOutcome } from "./outcomes.js";
import { StrategyMonitor } from "../strategy/strategyMonitor.js";
import { LearningEngine } from "../learning/learningEngine.js";
import { EvolutionRunner } from "../evolution/evolutionRunner.js";

export interface ResearchNotifier {
  activity(level: ActivityLevel, category: string, message: string, data?: Record<string, unknown>): void;
  strategiesChanged(): void;
}

/**
 * Everything research-related, designed to run in its own worker thread:
 * outcome labelling, discovery runs, the strategy pipeline (DISCOVERED → TESTING → backtest →
 * PAPER_TRADING / REJECTED), paper validation & decay monitoring, learning, situation clusters and
 * the analogue index.
 */
export class ResearchRuntime extends BaseModule {
  readonly strategies: StrategyService;
  readonly labeler: OutcomeLabeler;
  readonly discovery: DiscoveryRunner;
  readonly backtests: BacktestRunner;
  readonly analogues = new AnalogueIndex();
  readonly monitor: StrategyMonitor;
  readonly evolution: EvolutionRunner;
  readonly learning: LearningEngine;
  private settingsValue: Settings;
  private lastDiscoveryAt = 0;
  private lastEvolutionAt = 0;
  private backtestBusy = false;

  constructor(
    private readonly db: Database,
    settings: Settings,
    private readonly notify: ResearchNotifier,
    log: Logger,
    private readonly clock: Clock = systemClock,
  ) {
    super("research", log);
    this.settingsValue = settings;
    this.strategies = new StrategyService(db);
    this.strategies.onStatusChange(() => this.notify.strategiesChanged());
    this.labeler = new OutcomeLabeler(db, () => this.settingsValue, clock, log.child({ module: "labeler" }));
    this.discovery = new DiscoveryRunner(db, this.strategies, () => this.settingsValue, log.child({ module: "discovery" }));
    this.backtests = new BacktestRunner(db, this.strategies, () => this.settingsValue, log.child({ module: "backtest" }));
    this.monitor = new StrategyMonitor(db, this.strategies, () => this.settingsValue, notify, log.child({ module: "monitor" }));
    this.learning = new LearningEngine(db, log.child({ module: "learning" }));
    this.evolution = new EvolutionRunner(db, this.strategies, () => this.settingsValue, log.child({ module: "evolution" }));
    this.every("pipeline", 60_000, () => this.pipeline());
    this.every("discovery-schedule", 60_000, () => this.maybeDiscover());
    this.every("evolution-schedule", 5 * 60_000, () => this.maybeEvolve());
    this.every("analogues", 15 * 60_000, () => this.rebuildAnalogues(), true);
    this.every("clusters", 60 * 60_000, () => this.clusterJob().then(() => undefined));
    this.every("monitor", 5 * 60_000, () => this.monitor.run());
    this.every("learning", 5 * 60_000, () => this.learning.run().then(() => undefined));
  }

  get settings(): Settings {
    return this.settingsValue;
  }

  updateSettings(s: Settings): void {
    this.settingsValue = s;
  }

  protected override async onStart(): Promise<void> {
    await this.labeler.start();
    const last = await this.db.one<{ started_at: Date }>("SELECT started_at FROM discovery_runs ORDER BY id DESC LIMIT 1");
    this.lastDiscoveryAt = last?.started_at.getTime() ?? 0;
    const lastEvo = await this.db.one<{ started_at: Date }>("SELECT started_at FROM evolution_runs ORDER BY id DESC LIMIT 1");
    this.lastEvolutionAt = lastEvo?.started_at.getTime() ?? 0;
  }

  protected override async onStop(): Promise<void> {
    await this.labeler.stop();
  }

  healthAll(): ModuleHealth[] {
    return [this.health(), this.labeler.health()];
  }

  override healthDetail(): string {
    return `analogueIndex=${this.analogues.size} discovery=${this.discovery.running ? "running" : "idle"} evolution=${this.evolution.running ? "running" : "idle"} backtest=${this.backtestBusy ? "running" : "idle"}`;
  }

  private async maybeDiscover(): Promise<void> {
    const interval = this.settingsValue.research.discoveryIntervalMin;
    if (interval <= 0 || this.discovery.running) return;
    if (this.clock.now() - this.lastDiscoveryAt < interval * 60_000) return;
    await this.runDiscovery();
  }

  async runDiscovery(): Promise<unknown> {
    this.lastDiscoveryAt = this.clock.now();
    this.notify.activity("info", "discovery", "Strategy discovery started");
    const r = await this.discovery.run();
    if (r.status === "insufficient_data") {
      this.notify.activity("info", "discovery", `Discovery: not enough labelled data yet (${r.log.at(-1) ?? ""})`, { runId: r.runId });
    } else if (r.status === "failed") {
      this.notify.activity("error", "discovery", "Discovery run failed", { runId: r.runId, error: r.log[0] });
    } else {
      this.notify.activity(r.survivors > 0 ? "success" : "info", "discovery", `Discovery: ${r.hypothesesTested} hypotheses tested, ${r.survivors} survived all checks`, {
        runId: r.runId,
        created: r.strategiesCreated,
      });
    }
    if (r.strategiesCreated.length > 0) this.notify.strategiesChanged();
    await this.pipeline();
    return r;
  }

  private async maybeEvolve(): Promise<void> {
    const interval = this.settingsValue.research.evolutionIntervalMin;
    if (interval <= 0 || this.evolution.running || this.discovery.running) return;
    if (this.clock.now() - this.lastEvolutionAt < interval * 60_000) return;
    await this.runEvolution();
  }

  /** Search active strategies for better variants; each proposal becomes a challenger version. */
  async runEvolution(): Promise<unknown> {
    this.lastEvolutionAt = this.clock.now();
    const r = await this.evolution.run();
    if (r.status === "failed") this.notify.activity("error", "evolution", "Strategy evolution run failed", { runId: r.runId });
    else if (r.status === "insufficient_data") this.notify.activity("info", "evolution", "Strategy evolution: not enough labelled data yet", { runId: r.runId });
    else if (r.status === "done") {
      this.notify.activity(r.proposed.length > 0 ? "success" : "info", "evolution", `Strategy evolution: ${r.examined} strategies examined, ${r.proposed.length} challenger version(s) proposed`, {
        runId: r.runId,
        proposed: r.proposed,
      });
    }
    if (r.proposed.length > 0) {
      this.notify.strategiesChanged();
      await this.pipeline();
    }
    return r;
  }

  /** DISCOVERED → TESTING → backtest → PAPER_TRADING / REJECTED; challenger versions: backtest gate. */
  async pipeline(): Promise<void> {
    for (const s of await this.strategies.list(["DISCOVERED"])) {
      await this.strategies.transition(s.id, "TESTING", "queued for backtest", "system");
    }
    if (this.backtestBusy) return;
    const testing = await this.strategies.list(["TESTING"]);
    for (const s of testing) {
      if (!s.current_version_id) continue;
      await this.backtestAndPromote(s.id, s.current_version_id);
    }
    for (const v of await this.strategies.challengers("TESTING")) {
      await this.backtestChallenger(v.strategy_id, v.id, v.version);
    }
  }

  /** A challenger only enters paper trading if its causal, cost-aware backtest passes. */
  async backtestChallenger(strategyId: string, versionId: string, version: string): Promise<void> {
    if (this.backtestBusy) return;
    this.backtestBusy = true;
    try {
      const to = new Date(this.clock.now());
      const from = new Date(to.getTime() - 14 * 86_400_000);
      const r = await this.backtests.run(versionId, { from, to });
      const st = r.result.stats;
      if (r.passed) {
        await this.strategies.updateChallenger(versionId, { status: "PAPER_TRADING", reason: `backtest passed (${st.n} trades, net ${st.sum.toFixed(4)} SOL)` });
      } else {
        await this.strategies.updateChallenger(versionId, { status: "REJECTED", outcome: "retired", reason: `backtest: ${r.reason}` });
      }
      this.notify.activity(r.passed ? "success" : "info", "evolution", `Challenger ${strategyId} v${version}: backtest ${r.passed ? "passed → paper comparison" : `failed (${r.reason})`}`, {
        backtestId: r.backtestId,
        versionId,
      });
    } catch (err) {
      this.notify.activity("error", "evolution", `Challenger backtest failed for ${versionId}: ${(err as Error).message}`);
    } finally {
      this.backtestBusy = false;
    }
  }

  async backtestAndPromote(strategyId: string, versionId: string): Promise<{ passed: boolean; reason: string } | null> {
    if (this.backtestBusy) return null;
    this.backtestBusy = true;
    try {
      const to = new Date(this.clock.now());
      const from = new Date(to.getTime() - 14 * 86_400_000);
      this.notify.activity("info", "backtest", `Backtest started for ${strategyId}`);
      const r = await this.backtests.run(versionId, { from, to });
      const st = r.result.stats;
      const s = await this.strategies.get(strategyId);
      if (s?.status === "TESTING") {
        if (r.passed) {
          await this.strategies.transition(strategyId, "PAPER_TRADING", `backtest passed (${st.n} trades, net ${st.sum.toFixed(4)} SOL)`, "system", { backtestId: r.backtestId });
        } else {
          await this.strategies.transition(strategyId, "REJECTED", r.reason, "system", { backtestId: r.backtestId });
        }
      }
      this.notify.activity(r.passed ? "success" : "warning", "backtest", `Backtest ${strategyId}: ${st.n} trades, net ${st.sum.toFixed(4)} SOL, PF ${Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"} → ${r.passed ? "paper trading" : r.reason}`, {
        backtestId: r.backtestId,
      });
      return { passed: r.passed, reason: r.reason };
    } catch (err) {
      this.notify.activity("error", "backtest", `Backtest failed for ${strategyId}: ${(err as Error).message}`);
      return null;
    } finally {
      this.backtestBusy = false;
    }
  }

  private async loadSituationSamples(days: number, maxRows: number): Promise<SituationSample[]> {
    const rows = await this.db.many<{ id: number; ts: Date; mint: string; venue: string; age_sec: number; features: Record<string, number>; outcome: SampleOutcome }>(
      `SELECT id, ts, mint, venue, age_sec, features, outcome FROM research_samples
        WHERE labeled_at IS NOT NULL AND ts > now() - ($1 || ' days')::interval AND (outcome->'entry'->>'ok')::boolean
        ORDER BY ts DESC LIMIT $2`,
      [String(days), maxRows],
    );
    return rows.map((r) => ({ id: r.id, ts: r.ts.getTime(), mint: r.mint, venue: r.venue, ageSec: r.age_sec, features: r.features, outcome: r.outcome }));
  }

  async rebuildAnalogues(): Promise<void> {
    const samples = await this.loadSituationSamples(7, 50_000);
    if (samples.length < 200) return;
    this.analogues.build(samples);
  }

  queryAnalogues(features: Record<string, number>, venue: string, ageSec: number): AnalogueResult | null {
    return this.analogues.query(features, venue, ageSec, ["60", "300", "900", "3600"]);
  }

  async clusterJob(): Promise<number> {
    const samples = await this.loadSituationSamples(7, 30_000);
    if (samples.length < 500) return 0;
    const { clusters } = clusterSituations(samples, 12, ["60", "300", "900", "3600"]);
    const runId = new Date(this.clock.now()).toISOString();
    const from = new Date(Math.min(...samples.map((s) => s.ts)));
    const to = new Date(Math.max(...samples.map((s) => s.ts)));
    await this.db.insertMany(
      "situation_clusters",
      ["run_id", "cluster_index", "size", "features", "centroid", "description", "stats", "period_start", "period_end"],
      clusters.map((c) => [runId, c.index, c.size, JSON.stringify(Object.keys(c.centroid)), JSON.stringify(c.centroid), JSON.stringify(c.description), JSON.stringify(c.stats), from, to]),
    );
    await this.db.query("DELETE FROM situation_clusters WHERE run_at < now() - interval '7 days'");
    return clusters.length;
  }
}
