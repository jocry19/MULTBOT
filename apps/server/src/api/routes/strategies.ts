import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { describeCondition, strategySpecSchema, type StrategyStatus } from "@multbot/shared";
import type { App } from "../../app/app.js";
import { requireConfiguredAuth, type AuthPolicy } from "../auth.js";
import { LIVE_STATE_KEY } from "../../modules/live/liveEngine.js";

export async function registerStrategyRoutes(f: FastifyInstance, app: App, policy: AuthPolicy): Promise<void> {
  const moneyGuard = requireConfiguredAuth(policy);

  f.get("/api/strategies", async () => {
    const rows = await app.db.many<Record<string, unknown>>(
      `SELECT s.*, v.version, v.spec, v.created_at AS version_created_at,
              (SELECT metrics FROM strategy_results r WHERE r.strategy_version_id = s.current_version_id AND r.kind = 'discovery' ORDER BY computed_at DESC LIMIT 1) AS discovery,
              (SELECT metrics FROM strategy_results r WHERE r.strategy_version_id = s.current_version_id AND r.kind = 'backtest' ORDER BY computed_at DESC LIMIT 1) AS backtest,
              (SELECT metrics FROM strategy_results r WHERE r.strategy_version_id = s.current_version_id AND r.kind = 'paper' ORDER BY computed_at DESC LIMIT 1) AS paper,
              (SELECT count(*) FROM paper_trades p WHERE p.strategy_id = s.id AND p.status = 'CLOSED')::int8 AS paper_trades,
              (SELECT count(*) FROM live_trades l WHERE l.strategy_id = s.id AND l.status = 'CLOSED')::int8 AS live_trades,
              (SELECT sum(net_pnl_sol) FROM live_trades l WHERE l.strategy_id = s.id) AS live_net_sol
         FROM strategies s LEFT JOIN strategy_versions v ON v.id = s.current_version_id ORDER BY s.seq DESC`,
    );
    return rows.map((r) => ({
      ...r,
      description: ((r.spec as { conditions?: never[] } | null)?.conditions ?? []).map((c) => describeCondition(c)),
    }));
  });

  f.get("/api/strategies/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const s = await app.strategies.get(id);
    if (!s) return reply.code(404).send({ error: "strategy not found" });
    const versions = await app.strategies.versions(id);
    const results = await app.db.many(
      "SELECT r.id, r.strategy_version_id, r.kind, r.period_start, r.period_end, r.computed_at, r.metrics FROM strategy_results r JOIN strategy_versions v ON v.id = r.strategy_version_id WHERE v.strategy_id = $1 ORDER BY r.computed_at DESC LIMIT 200",
      [id],
    );
    const backtests = await app.db.many(
      "SELECT b.id, b.strategy_version_id, b.created_at, b.status, b.metrics, b.equity_curve, b.cost_breakdown, b.regime_breakdown FROM backtests b JOIN strategy_versions v ON v.id = b.strategy_version_id WHERE v.strategy_id = $1 ORDER BY b.id DESC LIMIT 10",
      [id],
    );
    const paperCurve = await app.db.many(
      "SELECT closed_at AS ts, sum(net_pnl_sol) OVER (ORDER BY closed_at) AS equity, net_pnl_sol, net_return, exit_reason FROM paper_trades WHERE strategy_id = $1 AND status = 'CLOSED' ORDER BY closed_at",
      [id],
    );
    const learning = await app.db.many("SELECT key, value, updated_at FROM learning_state WHERE key LIKE $1", [`strategy:${s.current_version_id}:%`]);
    const worstPaper = await app.db.many(
      "SELECT id, mint, closed_at, net_pnl_sol, net_return, exit_reason, regime FROM paper_trades WHERE strategy_id = $1 AND status = 'CLOSED' ORDER BY net_pnl_sol ASC LIMIT 10",
      [id],
    );
    return {
      strategy: s,
      versions: versions.map((v) => ({ ...v, description: v.spec.conditions.map(describeCondition) })),
      results,
      backtests,
      paperCurve,
      worstPaperTrades: worstPaper,
      learning,
      history: await app.strategies.history(id),
    };
  });

  f.post("/api/strategies/:id/backtest", async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const s = await app.strategies.get(id);
    if (!s?.current_version_id) return reply.code(404).send({ error: "strategy not found" });
    void app.research.request("runBacktest", { strategyId: id, versionId: s.current_version_id }).catch((err) => app.activity.error("backtest", (err as Error).message));
    return { queued: true };
  });

  const transition = (to: StrategyStatus, reason: string) => async (req: { params: unknown }) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const s = await app.strategies.transition(id, to, reason, "user");
    app.activity.info("strategy", `${id} → ${to} (user)`);
    return s;
  };

  f.post("/api/strategies/:id/pause", transition("PAUSED", "paused by user"));
  f.post("/api/strategies/:id/disable", transition("REJECTED", "MANUAL: disabled by user"));
  f.post("/api/strategies/:id/resume", async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const s = await app.strategies.get(id);
    if (!s) return reply.code(404).send({ error: "not found" });
    const history = await app.strategies.history(id);
    const before = (history.find((h) => h.to_status === "PAUSED") as { from_status?: StrategyStatus } | undefined)?.from_status;
    const target: StrategyStatus = before === "PAPER_VALIDATED" || before === "LIVE_ENABLED" ? "PAPER_VALIDATED" : before === "TESTING" ? "TESTING" : "PAPER_TRADING";
    return app.strategies.transition(id, target, "resumed by user", "user");
  });
  f.post("/api/strategies/:id/retest", transition("TESTING", "re-test requested by user"));
  f.post("/api/strategies/:id/paper", async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await app.strategies.setPaperEnabled(id, enabled);
    await app.paper.reload();
    return { paperEnabled: enabled };
  });

  /** ENABLE REAL TRADING — explicit user action with typed confirmation; never automatic. */
  f.post("/api/strategies/:id/enable-live", { preHandler: moneyGuard }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    z.object({ confirm: z.literal("ENABLE REAL TRADING") }).parse(req.body);
    const s = await app.strategies.get(id);
    if (!s) return reply.code(404).send({ error: "not found" });
    if (s.status !== "PAPER_VALIDATED") return reply.code(400).send({ error: `strategy must be PAPER_VALIDATED (is ${s.status})` });
    if (!app.wallet.signer) return reply.code(400).send({ error: "bot wallet not configured" });
    const updated = await app.strategies.transition(id, "LIVE_ENABLED", "enabled for real trading by user", "user");
    if (app.live.liveState !== "ACTIVE") await app.state.setState(LIVE_STATE_KEY, { state: "ACTIVE", activatedAt: new Date().toISOString(), activatedBy: "user" });
    await app.live.reload();
    app.activity.warn("live", `REAL TRADING ENABLED for ${id} by user`);
    return updated;
  });

  f.post("/api/strategies/:id/disable-live", async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const s = await app.strategies.transition(id, "PAPER_VALIDATED", "live trading disabled by user", "user");
    await app.live.reload();
    return s;
  });

  f.post("/api/strategies/:id/versions/:versionId/activate", async (req) => {
    const { id, versionId } = z.object({ id: z.string().max(40), versionId: z.string().max(60) }).parse(req.params);
    await app.strategies.setCurrentVersion(id, versionId, "user");
    await app.paper.reload();
    await app.live.reload();
    return { ok: true };
  });

  /** Manually defined strategy (goes through the same backtest → paper pipeline). */
  f.post("/api/strategies", async (req, reply) => {
    const b = z.object({ name: z.string().min(3).max(120), spec: strategySpecSchema }).parse(req.body);
    const r = await app.strategies.create({ spec: b.spec, origin: "manual", name: b.name });
    if (!r) return reply.code(409).send({ error: "an identical strategy already exists" });
    app.research.request("monitorNow").catch(() => undefined);
    return r;
  });

  // --- discovery ----------------------------------------------------------------------------
  f.get("/api/discovery/runs", async () =>
    app.db.many("SELECT id, started_at, finished_at, status, dataset, hypotheses_tested, survivors, summary, error FROM discovery_runs ORDER BY id DESC LIMIT 50"),
  );
  f.get("/api/discovery/runs/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [run, hypotheses] = await Promise.all([
      app.db.one("SELECT * FROM discovery_runs WHERE id = $1", [id]),
      app.db.many("SELECT * FROM hypotheses WHERE run_id = $1 ORDER BY verdict DESC, q_value ASC NULLS LAST, p_value ASC LIMIT 500", [id]),
    ]);
    return { run, hypotheses };
  });
  f.post("/api/discovery/run", async () => {
    void app.research.request("runDiscovery").catch((err) => app.activity.error("discovery", (err as Error).message));
    return { queued: true };
  });

  // --- evolution ----------------------------------------------------------------------------
  f.get("/api/evolution/runs", async () =>
    app.db.many("SELECT id, started_at, finished_at, status, dataset, examined, proposed, summary, error FROM evolution_runs ORDER BY id DESC LIMIT 50"),
  );
  f.get("/api/evolution/challengers", async () =>
    app.db.many(
      `SELECT v.id, v.strategy_id, v.version, v.status, v.change_summary, v.challenger_since, v.challenger_outcome, v.challenger_reason, v.created_at,
              s.name, s.status AS strategy_status, s.current_version_id,
              (SELECT metrics FROM strategy_results r WHERE r.strategy_version_id = v.id AND r.kind = 'challenger' ORDER BY computed_at DESC LIMIT 1) AS comparison,
              (SELECT metrics FROM strategy_results r WHERE r.strategy_version_id = v.id AND r.kind = 'evolution' ORDER BY computed_at DESC LIMIT 1) AS evidence
         FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id
        WHERE v.challenger_since IS NOT NULL OR v.challenger_outcome IS NOT NULL
        ORDER BY v.created_at DESC LIMIT 200`,
    ),
  );
  f.post("/api/evolution/run", async () => {
    void app.research.request("runEvolution").catch((err) => app.activity.error("evolution", (err as Error).message));
    return { queued: true };
  });

  f.get("/api/backtests", async (req) => {
    const q = z.object({ strategyId: z.string().max(40).optional() }).parse(req.query);
    return app.db.many(
      `SELECT b.id, b.strategy_version_id, v.strategy_id, b.created_at, b.finished_at, b.status, b.metrics, b.period_start, b.period_end, b.error
         FROM backtests b JOIN strategy_versions v ON v.id = b.strategy_version_id ${q.strategyId ? "WHERE v.strategy_id = $1" : ""}
        ORDER BY b.id DESC LIMIT 100`,
      q.strategyId ? [q.strategyId] : [],
    );
  });
  f.get("/api/backtests/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const [bt, trades] = await Promise.all([
      app.db.one("SELECT * FROM backtests WHERE id = $1", [id]),
      app.db.many("SELECT * FROM backtest_trades WHERE backtest_id = $1 ORDER BY seq LIMIT 2000", [id]),
    ]);
    return { backtest: bt, trades };
  });
}
