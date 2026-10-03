import type { Settings, StrategyStatus } from "@multbot/shared";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import { loadDataset } from "../discovery/dataset.js";
import type { StrategyService } from "../strategy/strategyService.js";
import { DEFAULT_EVOLUTION, proposeVariant } from "./variants.js";

/**
 * Periodic strategy evolution: for every active strategy without a running challenger, search for one
 * better variant on recent research data and register it as a challenger version. Challengers then go
 * through the causal backtest and a paper-trading comparison against the current version
 * (StrategyMonitor). Nothing here touches real money.
 */

const ACTIVE: StrategyStatus[] = ["PAPER_TRADING", "PAPER_VALIDATED", "LIVE_ENABLED", "DEGRADED"];

export interface EvolutionRunSummary {
  runId: number;
  status: "done" | "insufficient_data" | "failed" | "nothing_to_do";
  examined: number;
  proposed: { strategyId: string; versionId: string; summary: string }[];
}

const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

export class EvolutionRunner {
  running = false;

  constructor(
    private readonly db: Database,
    private readonly strategies: StrategyService,
    private readonly settings: () => Settings,
    private readonly log: Logger,
  ) {}

  async run(opts: { lookbackDays?: number; maxRows?: number } = {}): Promise<EvolutionRunSummary> {
    if (this.running) return { runId: 0, status: "nothing_to_do", examined: 0, proposed: [] };
    this.running = true;
    const run = await this.db.one<{ id: number }>("INSERT INTO evolution_runs (status) VALUES ('running') RETURNING id");
    const runId = run?.id ?? 0;
    const proposed: EvolutionRunSummary["proposed"] = [];
    let examined = 0;
    const finish = async (status: EvolutionRunSummary["status"], extra: Record<string, unknown> = {}, error: string | null = null) => {
      await this.db.query("UPDATE evolution_runs SET status = $2, finished_at = now(), examined = $3, proposed = $4, summary = $5, error = $6 WHERE id = $1", [
        runId,
        status,
        examined,
        proposed.length,
        JSON.stringify({ proposed, ...extra }),
        error,
      ]);
      return { runId, status, examined, proposed };
    };
    try {
      const busy = new Set((await this.strategies.challengers()).map((c) => c.strategy_id));
      const todo = (await this.strategies.list(ACTIVE)).filter((s) => s.current_version_id && !busy.has(s.id));
      if (todo.length === 0) return await finish("nothing_to_do");

      const to = new Date();
      const from = new Date(to.getTime() - (opts.lookbackDays ?? 14) * 86_400_000);
      const ds = await loadDataset(this.db, { from, to, maxRows: opts.maxRows ?? 120_000 });
      await this.db.query("UPDATE evolution_runs SET dataset = $2 WHERE id = $1", [runId, JSON.stringify({ n: ds.n, from: ds.period.from, to: ds.period.to })]);
      if (ds.n < 1000) return await finish("insufficient_data", { rows: ds.n });

      const cfg = this.settings().research;
      for (const s of todo) {
        const v = await this.strategies.version(s.current_version_id as string);
        if (!v) continue;
        examined++;
        const learned = await this.db.one<{ value: { weakRegimes?: string[] } }>("SELECT value FROM learning_state WHERE key = $1", [`strategy:${v.id}:paper`]);
        const p = proposeVariant(ds, v.spec, {
          ...DEFAULT_EVOLUTION,
          minTrainN: Math.max(DEFAULT_EVOLUTION.minTrainN, Math.floor(cfg.minSampleSize / 4)),
          weakRegimes: learned?.value.weakRegimes ?? [],
        });
        if (!p) continue;
        const summary = `${p.variant.summary} — Holdout Ø ${pct(p.parent.holdout.mean)} → ${pct(p.candidate.holdout.mean)} (n=${p.candidate.holdout.n})`;
        const created = await this.strategies.createChallenger({
          strategyId: s.id,
          parentVersionId: v.id,
          spec: p.variant.spec,
          bump: p.variant.bump,
          changeSummary: summary,
          evidence: { runId, ...p, variant: { kind: p.variant.kind, bump: p.variant.bump, target: p.variant.target, summary: p.variant.summary } },
        });
        if (created) proposed.push({ strategyId: s.id, versionId: created.versionId, summary });
      }
      return await finish("done", { rows: ds.n });
    } catch (err) {
      this.log.error({ err }, "evolution run failed");
      return await finish("failed", {}, (err as Error).message);
    } finally {
      this.running = false;
    }
  }
}
