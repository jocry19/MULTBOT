import { strategySpecSchema, type Settings, type StrategySpec } from "@multbot/shared";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import type { StrategyService } from "../strategy/strategyService.js";
import { loadDataset } from "./dataset.js";
import { DEFAULT_DISCOVERY, DiscoveryEngine, type CandidateReport, type DiscoveryConfig } from "./engine.js";

export function discoveryConfigFromSettings(s: Settings): DiscoveryConfig {
  return {
    ...DEFAULT_DISCOVERY,
    maxConditions: s.research.maxConditionsPerRecipe,
    minSamples: s.research.minSampleSize,
    fdrAlpha: s.research.fdrAlpha,
    maxHypotheses: s.research.maxHypothesesPerRun,
    walkForwardFolds: s.research.walkForwardFolds,
  };
}

export function candidateToSpec(c: CandidateReport, runId: number): StrategySpec {
  const [kind, h, tp, sl] = c.target.split(":");
  const horizonSec = Number(h);
  const exit =
    kind === "tpsl"
      ? { takeProfitPct: Number(tp), stopLossPct: Number(sl), maxHoldSec: horizonSec, invalidation: [], expectedValueExit: false }
      : { maxHoldSec: horizonSec, invalidation: [], expectedValueExit: false };
  return strategySpecSchema.parse({
    family: "recipe",
    universe: { venues: c.venues.length > 0 ? c.venues : ["pump_curve", "pump_amm"] },
    conditions: c.conditions,
    entry: { cooldownSec: horizonSec },
    exit,
    horizonSec,
    params: { target: c.target, discoveryRunId: runId },
  });
}

/** Compact evidence report stored with the strategy (shown in the Strategy Lab). */
export function evidenceFromCandidate(c: CandidateReport, runId: number): Record<string, unknown> {
  return {
    runId,
    target: c.target,
    recipe: c.description,
    occurrences: c.train.n + (c.validation?.n ?? 0) + (c.holdout?.n ?? 0),
    train: c.train,
    validation: c.validation,
    holdout: c.holdout,
    walkForward: c.walkForward,
    multipleTesting: c.multipleTesting,
    overfit: c.overfit,
    regimes: c.regimes,
    nearMisses: c.nearMisses,
    worstTrades: c.worstTrades,
    costShare: c.costShare,
    baselineMean: c.baselineMean,
    whyItMightFail: c.whyItMightFail,
    samplePeriod: c.samplePeriod,
    derived: c.derived,
  };
}

export interface DiscoveryRunSummary {
  runId: number;
  status: "done" | "insufficient_data" | "failed";
  hypothesesTested: number;
  survivors: number;
  strategiesCreated: { strategyId: string; versionId: string }[];
  log: string[];
}

/** Loads the research dataset, runs discovery, persists hypotheses and creates strategies. */
export class DiscoveryRunner {
  running = false;

  constructor(
    private readonly db: Database,
    private readonly strategies: StrategyService,
    private readonly settings: () => Settings,
    private readonly log: Logger,
  ) {}

  async run(opts: { lookbackDays?: number; maxRows?: number } = {}): Promise<DiscoveryRunSummary> {
    if (this.running) throw new Error("discovery already running");
    this.running = true;
    const cfg = discoveryConfigFromSettings(this.settings());
    const run = await this.db.one<{ id: number }>("INSERT INTO discovery_runs (status, config) VALUES ('running', $1) RETURNING id", [JSON.stringify(cfg)]);
    const runId = run?.id as number;
    try {
      const to = new Date();
      const from = new Date(to.getTime() - (opts.lookbackDays ?? 14) * 86_400_000);
      const ds = await loadDataset(this.db, { from, to, maxRows: opts.maxRows ?? 60_000 });
      const engine = new DiscoveryEngine(ds, cfg);
      const result = engine.run();
      const created: { strategyId: string; versionId: string }[] = [];

      if (result.hypotheses.length > 0) {
        await this.db.insertMany(
          "hypotheses",
          ["run_id", "conditions", "horizon_sec", "n_train", "mean_train", "p_value", "q_value", "n_test", "mean_test", "walk_forward", "verdict", "reject_reason"],
          result.hypotheses.map((h) => [
            runId,
            JSON.stringify({ target: h.target, conditions: h.conditions }),
            Number(h.target.split(":")[1]),
            h.nTrain,
            h.meanTrain,
            h.pValue,
            h.qValue,
            h.nTest,
            h.meanTest,
            h.walkForward === null ? null : JSON.stringify(h.walkForward),
            h.verdict,
            h.rejectReason,
          ]),
        );
      }

      for (const c of result.candidates.filter((x) => x.verdict === "survived")) {
        for (const d of c.derived) {
          await this.db.query(
            `INSERT INTO features (name, kind, expression, description) VALUES ($1, 'discovered', $2, $3)
             ON CONFLICT (name) DO UPDATE SET enabled = true, updated_at = now()`,
            [d.name, JSON.stringify(d), `${d.op}(${d.args.join(", ")}) — discovered in run ${runId}`],
          );
        }
        const spec = candidateToSpec(c, runId);
        const res = await this.strategies.create({ spec, origin: "discovered", discoveryRunId: runId, evidence: evidenceFromCandidate(c, runId) });
        if (res) {
          created.push({ strategyId: res.strategyId, versionId: res.versionId });
          await this.db.query("UPDATE hypotheses SET strategy_id = $1 WHERE run_id = $2 AND conditions = $3", [
            res.strategyId,
            runId,
            JSON.stringify({ target: c.target, conditions: c.conditions }),
          ]);
        }
      }

      const status = result.insufficientData ? "insufficient_data" : "done";
      await this.db.query(
        `UPDATE discovery_runs SET status = $2, finished_at = now(), dataset = $3, hypotheses_tested = $4, survivors = $5, summary = $6 WHERE id = $1`,
        [
          runId,
          status,
          JSON.stringify(result.dataset),
          result.hypothesesTested,
          result.candidates.filter((c) => c.verdict === "survived").length,
          JSON.stringify({
            log: result.log,
            rejected: result.candidates.filter((c) => c.verdict === "rejected").map((c) => ({ recipe: c.description, target: c.target, reason: c.rejectReason })),
            created,
          }),
        ],
      );
      return {
        runId,
        status,
        hypothesesTested: result.hypothesesTested,
        survivors: result.candidates.filter((c) => c.verdict === "survived").length,
        strategiesCreated: created,
        log: result.log,
      };
    } catch (err) {
      await this.db.query("UPDATE discovery_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [runId, (err as Error).message]);
      this.log.error({ err }, "discovery run failed");
      return { runId, status: "failed", hypothesesTested: 0, survivors: 0, strategiesCreated: [], log: [(err as Error).message] };
    } finally {
      this.running = false;
    }
  }
}
