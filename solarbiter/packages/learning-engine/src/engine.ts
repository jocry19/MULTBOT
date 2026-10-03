import type { ExecutionFeatures, Settings } from "@solarbiter/shared";
import { evaluateLiveGate, learningScore, type GateCounts, type GateResult, type LearningStatus } from "./gate.js";
import { ExecutionModel, LatencyModel, ReliabilityModel, SlippageModel, type LearningSample } from "./models.js";
import { validate, type ValidationReport } from "./validation.js";

export interface LearningSnapshot {
  samples: number;
  successRate: number | null;
  executionModelTrained: boolean;
  expectedSlippageBps: number;
  slippageStdBps: number;
  latencyMs: number;
  latencySamples: number;
  score: number;
  status: LearningStatus;
  gate: GateResult;
  report: ValidationReport | null;
  counts: GateCounts;
  refittedAt: number | null;
}

/**
 * Statistical learning (no black-box RL): execution probability, spread decay / slippage, latency,
 * route reliability, fee accuracy — refitted from recorded outcomes after every trade, validated
 * chronologically (60/20/20 + walk-forward). Its only outputs are estimates and a live-gate verdict;
 * it cannot change risk limits and cannot enable live trading.
 */
export class LearningEngine {
  private samples: LearningSample[] = [];
  private readonly exec = new ExecutionModel();
  private readonly slip = new SlippageModel();
  private readonly latency: LatencyModel;
  private readonly reliabilityModel = new ReliabilityModel();
  private report: ValidationReport | null = null;
  private counts: GateCounts = { paperOpportunities: 0, simulatedExecutions: 0, latencySamples: 0 };
  private refittedAt: number | null = null;
  private lastValidationAt = 0;

  constructor(
    private settings: () => Settings,
    private readonly now: () => number = Date.now,
    private readonly maxSamples = 50_000,
  ) {
    this.latency = new LatencyModel(settings().paper.defaultLatencyMs);
  }

  /** Load history (oldest first) at startup. */
  load(samples: LearningSample[], paperOpportunities: number): void {
    this.samples = samples.slice(-this.maxSamples);
    this.counts.paperOpportunities = paperOpportunities;
    this.refit(true);
  }

  countOpportunity(n = 1): void {
    this.counts.paperOpportunities += n;
  }

  /** Learning after every trade. Validation (heavier) runs at most once a minute. */
  ingest(s: LearningSample): void {
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.refit(this.now() - this.lastValidationAt > 60_000);
  }

  private refit(withValidation: boolean): void {
    const s = this.settings();
    this.latency.setDefault(s.paper.defaultLatencyMs);
    this.exec.fit(this.samples);
    this.slip.fit(this.samples);
    this.latency.fit(this.samples);
    this.reliabilityModel.fit(this.samples);
    this.counts.simulatedExecutions = this.samples.length;
    this.counts.latencySamples = this.latency.samples();
    if (withValidation) {
      this.report = this.samples.length >= 50 ? validate(this.samples, s.learning.splits, s.learning.walkForwardFolds) : null;
      this.lastValidationAt = this.now();
    }
    this.refittedAt = this.now();
  }

  // --- estimates used by the evaluator (LearningPort) -------------------------------------------
  executionProbability(f: ExecutionFeatures): number {
    return this.exec.predict(f);
  }

  expectedSlippageBps(f: ExecutionFeatures): number {
    return this.slip.expectedBps(f);
  }

  slippageStdBps(): number {
    return this.slip.stdBps();
  }

  routeReliability(routeKey: string): number {
    return this.reliabilityModel.reliability(routeKey);
  }

  latencyMs(): number {
    return this.latency.estimateMs();
  }

  // --- reporting --------------------------------------------------------------------------------
  allSamples(): LearningSample[] {
    return this.samples;
  }

  gate(): GateResult {
    return evaluateLiveGate(this.counts, this.report, this.settings());
  }

  snapshot(): LearningSnapshot {
    const gate = this.gate();
    const { score, status } = learningScore(this.counts, this.report, gate, this.settings());
    const n = this.samples.length;
    return {
      samples: n,
      successRate: n ? this.samples.filter((x) => x.success).length / n : null,
      executionModelTrained: this.exec.weights.length > 0,
      expectedSlippageBps: this.slip.globalBps(),
      slippageStdBps: this.slip.stdBps(),
      latencyMs: this.latency.estimateMs(),
      latencySamples: this.latency.samples(),
      score,
      status,
      gate,
      report: this.report,
      counts: { ...this.counts },
      refittedAt: this.refittedAt,
    };
  }
}
