import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../../app/app.js";

export async function registerResearchRoutes(f: FastifyInstance, app: App): Promise<void> {
  f.get("/api/research/overview", async () => {
    const [samples, labeled, runs, features, clustersRun] = await Promise.all([
      app.db.one<{ n: number; oldest: Date | null }>("SELECT count(*)::int8 AS n, min(ts) AS oldest FROM research_samples"),
      app.db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM research_samples WHERE labeled_at IS NOT NULL"),
      app.db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM discovery_runs"),
      app.db.many("SELECT name, kind, description, enabled, created_at FROM features WHERE kind IN ('derived','discovered') ORDER BY created_at DESC LIMIT 100"),
      app.db.one<{ run_id: string }>("SELECT run_id FROM situation_clusters ORDER BY run_at DESC LIMIT 1"),
    ]);
    return {
      samples: samples?.n ?? 0,
      labeledSamples: labeled?.n ?? 0,
      oldestSample: samples?.oldest ?? null,
      discoveryRuns: runs?.n ?? 0,
      discoveredFeatures: features,
      latestClusterRun: clustersRun?.run_id ?? null,
      baselineContexts: app.indexer.baselines.contexts,
      eventTypes: app.indexer.events.detectorTypes,
    };
  });

  f.get("/api/research/situations", async () => {
    const latest = await app.db.one<{ run_id: string }>("SELECT run_id FROM situation_clusters ORDER BY run_at DESC LIMIT 1");
    if (!latest) return [];
    return app.db.many("SELECT * FROM situation_clusters WHERE run_id = $1 ORDER BY size DESC", [latest.run_id]);
  });

  f.post("/api/research/label-now", async () => ({ labeled: await app.research.request<number>("labelNow") }));
  f.post("/api/research/clusters-now", async () => ({ clusters: await app.research.request<number>("clusters") }));

  f.get("/api/learning", async (req) => {
    const q = z.object({ mode: z.enum(["paper", "live"]).optional() }).parse(req.query);
    const [states, recent, quality] = await Promise.all([
      app.db.many("SELECT key, value, updated_at FROM learning_state WHERE key LIKE 'strategy:%' ORDER BY updated_at DESC LIMIT 100"),
      app.db.many(
        `SELECT l.*, p.mint FROM learning_updates l LEFT JOIN paper_trades p ON p.id = l.trade_id ${q.mode ? "WHERE l.mode = $1" : ""} ORDER BY l.ts DESC LIMIT 100`,
        q.mode ? [q.mode] : [],
      ),
      app.db.many(
        `SELECT mode, decision_quality, outcome_quality, count(*)::int8 AS n FROM learning_updates GROUP BY mode, decision_quality, outcome_quality ORDER BY mode, decision_quality`,
      ),
    ]);
    return { states, recent, quality };
  });

  /** Execution calibration: realised live costs vs. research assumptions (feeds back into settings by the user). */
  f.get("/api/learning/execution-calibration", async () => {
    const live = await app.db.one<{ n: number; slip: number | null; prio: number | null; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'CLOSED')::int8 AS n,
              avg((entry_slippage_sol + exit_slippage_sol) / NULLIF(position_size_sol, 0)) FILTER (WHERE status = 'CLOSED') AS slip,
              avg(priority_fees_sol) FILTER (WHERE status = 'CLOSED') AS prio,
              count(*) FILTER (WHERE status = 'FAILED')::int8 AS failed
         FROM live_trades`,
    );
    const paper = await app.db.one<{ slip: number | null; prio: number | null }>(
      `SELECT avg((entry_slippage_sol + exit_slippage_sol) / NULLIF(position_size_sol, 0)) AS slip, avg(priority_fees_sol) AS prio FROM paper_trades WHERE status = 'CLOSED'`,
    );
    const s = app.state.get().research;
    return {
      liveTrades: live?.n ?? 0,
      sufficient: (live?.n ?? 0) >= 30,
      live: { slippageShare: live?.slip ?? null, priorityFeeSol: live?.prio ?? null, failedEntries: live?.failed ?? 0 },
      paper: { slippageShare: paper?.slip ?? null, priorityFeeSol: paper?.prio ?? null },
      assumptions: { failedTxRate: s.failedTxRate, assumedPriorityFeeSol: s.assumedPriorityFeeSol, mevImpactBps: s.mevImpactBps, executionDelayMs: s.executionDelayMs },
    };
  });
}
