import { STATE_KEYS } from "@solarbiter/database";
import { DEFAULT_LIVE_GATE, REJECTION_REASONS, type LiveGateRecord } from "@solarbiter/shared";
import { KEY_MARKETS, KEY_SCANNER_TABLE, KEY_WORKER_LEARNING, KEY_WORKER_PORTFOLIO, KEY_WORKER_RISK, KEY_WORKER_STARTUP } from "@solarbiter/shared/node";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { workerStatus, type ApiContext } from "../context.js";
import { explainOpportunity, type OpportunityRow } from "../explain.js";

const windowSchema = z.object({ hours: z.coerce.number().min(1).max(24 * 90).default(24) });

async function symbols(ctx: ApiContext): Promise<(mint: string) => string> {
  const rows = await ctx.db.many<{ mint: string; symbol: string }>("SELECT mint, symbol FROM tokens");
  const m = new Map(rows.map((r) => [r.mint, r.symbol]));
  return (mint) => m.get(mint) ?? `${mint.slice(0, 4)}…`;
}

export async function registerReadRoutes(f: FastifyInstance, ctx: ApiContext): Promise<void> {
  f.get("/api/status", async () => {
    const w = await workerStatus(ctx);
    const dbOk = await ctx.db.ping();
    const gate = ctx.store.getState<LiveGateRecord>(STATE_KEYS.liveGate, DEFAULT_LIVE_GATE);
    const startup = await ctx.bus.getJson(KEY_WORKER_STARTUP).catch(() => null);
    return {
      botState: w.online ? (w.status?.botState ?? "OFFLINE") : "OFFLINE",
      workerOnline: w.online,
      heartbeatAgeMs: w.heartbeatAgeMs,
      worker: w.status,
      startup,
      liveGate: gate,
      liveSwitch: ctx.config.liveMode,
      paperSwitch: ctx.config.paperMode,
      api: { database: dbOk ? "CONNECTED" : "DISCONNECTED", redis: ctx.bus.isHealthy ? "CONNECTED" : "DISCONNECTED", time: Date.now() },
    };
  });

  f.get("/api/markets", async () => {
    const markets = await ctx.bus.getJson(KEY_MARKETS).catch(() => null);
    const tokens = await ctx.db.many("SELECT mint, symbol, name, decimals, program, mint_authority, freeze_authority, allowlisted, denylisted, safe, safety_reasons, checked_at FROM tokens ORDER BY symbol");
    return { markets, tokens };
  });

  f.get("/api/scanner", async () => (await ctx.bus.getJson(KEY_SCANNER_TABLE).catch(() => null)) ?? { candidates: [], opportunities: [] });

  f.get("/api/opportunities", async (req) => {
    const q = z
      .object({
        status: z.string().max(20).optional(),
        reason: z.enum(REJECTION_REASONS).optional(),
        mode: z.enum(["paper", "live"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().optional(),
      })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) where.push(`status = $${params.push(q.status)}`);
    if (q.reason) where.push(`rejection_reason = $${params.push(q.reason)}`);
    if (q.mode) where.push(`mode = $${params.push(q.mode)}`);
    if (q.before) where.push(`ts < $${params.push(new Date(q.before).toISOString())}`);
    params.push(q.limit);
    return ctx.db.many(
      `SELECT id, ts, slot, mode, strategy_type, strategy_version_id, route, route_dexes, token_mint, size_eur, sol_eur, gross_profit_percent, expected_net_profit_eur,
              expected_net_profit_percent, execution_probability, price_impact, quote_age_ms, atomic, status, rejection_reason, rejection_detail
         FROM opportunities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT $${params.length}`,
      params,
    );
  });

  f.get("/api/opportunities/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const o = await ctx.db.one<OpportunityRow & Record<string, unknown>>("SELECT * FROM opportunities WHERE id = $1 ORDER BY ts DESC LIMIT 1", [id]);
    if (!o) return reply.code(404).send({ error: "not found" });
    const [paper, live, quotes] = await Promise.all([
      ctx.db.many("SELECT * FROM paper_trades WHERE opportunity_id = $1", [id]),
      ctx.db.many("SELECT * FROM live_trades WHERE opportunity_id = $1", [id]),
      ctx.db.many("SELECT id, ts, slot, source, input_mint, output_mint, input_amount, output_amount, min_output, slippage_bps, price, price_impact, route, latency_ms, purpose FROM quotes WHERE opportunity_id = $1 ORDER BY ts", [id]),
    ]);
    return { opportunity: o, explanation: explainOpportunity(o, await symbols(ctx)), paperTrades: paper, liveTrades: live, quotes };
  });

  f.get("/api/why-no-trade", async (req) => {
    const { hours } = windowSchema.parse(req.query);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const quoted = await ctx.db.many<{ reason: string; strategy_type: string; n: string }>(
      "SELECT rejection_reason AS reason, strategy_type, count(*)::text AS n FROM opportunities WHERE ts >= $1 AND rejection_reason IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC",
      [since],
    );
    const screened = await ctx.db.many<{ reason: string; strategy_type: string; n: string }>(
      "SELECT reason, strategy_type, sum(count)::text AS n FROM no_trade_stats WHERE bucket >= $1 GROUP BY 1, 2 ORDER BY 3 DESC",
      [since],
    );
    const executed = await ctx.db.one<{ n: string }>("SELECT count(*)::text AS n FROM opportunities WHERE ts >= $1 AND status IN ('EXECUTABLE','SIMULATED','CONFIRMED','SUBMITTED')", [since]);
    return {
      hours,
      quoteStage: quoted.map((r) => ({ reason: r.reason, strategyType: r.strategy_type, count: Number(r.n) })),
      screeningStage: screened.map((r) => ({ reason: r.reason, strategyType: r.strategy_type, count: Number(r.n) })),
      executable: Number(executed?.n ?? 0),
    };
  });

  for (const mode of ["paper", "live"] as const) {
    const table = mode === "paper" ? "paper_trades" : "live_trades";
    f.get(`/api/${mode}/performance`, async () => {
      const snap = await ctx.bus.getJson<Record<string, unknown>>(KEY_WORKER_PORTFOLIO).catch(() => null);
      const tsCol = mode === "paper" ? "ts_closed" : "COALESCE(ts_confirmed, ts_detected)";
      const okCond = mode === "paper" ? "success IS NOT NULL" : "status IN ('CONFIRMED','FAILED')";
      const stats = await ctx.db.one(
        `SELECT count(*)::int AS trades, count(*) FILTER (WHERE realized_net_eur > 0)::int AS wins, count(*) FILTER (WHERE realized_net_eur < 0)::int AS losses,
                COALESCE(sum(realized_net_eur), 0) AS net_eur, COALESCE(avg(realized_net_eur), 0) AS expectancy_eur, COALESCE(avg(prediction_error_bps), 0) AS avg_prediction_error_bps,
                COALESCE(max(realized_net_eur), 0) AS best_eur, COALESCE(min(realized_net_eur), 0) AS worst_eur, COALESCE(avg(size_eur), 0) AS avg_size_eur
           FROM ${table} WHERE ${okCond}`,
      );
      const daily = await ctx.db.many(`SELECT date_trunc('day', ${tsCol}) AS day, sum(realized_net_eur) AS net_eur, count(*)::int AS trades FROM ${table} WHERE ${okCond} GROUP BY 1 ORDER BY 1`);
      return { mode, portfolio: snap ? (snap as Record<string, unknown>)[mode] : null, solEur: snap?.solEur ?? null, stats, daily };
    });
    f.get(`/api/${mode}/trades`, async (req) => {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
      return ctx.db.many(`SELECT * FROM ${table} ORDER BY ${mode === "paper" ? "ts_detected" : "ts_detected"} DESC LIMIT $1`, [limit]);
    });
  }

  f.get("/api/transactions", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const [transactions, attempts, bundles] = await Promise.all([
      ctx.db.many("SELECT * FROM transactions ORDER BY ts DESC NULLS LAST LIMIT $1", [limit]),
      ctx.db.many("SELECT * FROM execution_attempts ORDER BY created_at DESC LIMIT $1", [limit]),
      ctx.db.many("SELECT * FROM jito_bundles ORDER BY ts DESC LIMIT $1", [limit]),
    ]);
    return { transactions, attempts, bundles };
  });

  f.get("/api/learning", async () => {
    const snap = await ctx.bus.getJson(KEY_WORKER_LEARNING).catch(() => null);
    const [history, versions] = await Promise.all([
      ctx.db.many("SELECT ts, kind, strategy_version_id, value FROM learning_metrics WHERE ts > now() - interval '30 days' ORDER BY ts DESC LIMIT 500"),
      ctx.db.many(
        `SELECT v.*, COALESCE(json_object_agg(p.key, p.value) FILTER (WHERE p.key IS NOT NULL), '{}') AS params
           FROM strategy_versions v LEFT JOIN strategy_parameters p ON p.strategy_version_id = v.id GROUP BY v.id ORDER BY v.version DESC`,
      ),
    ]);
    return { snapshot: snap, history, versions };
  });

  f.get("/api/risk", async () => {
    const snap = await ctx.bus.getJson(KEY_WORKER_RISK).catch(() => null);
    const events = await ctx.db.many("SELECT * FROM risk_events ORDER BY ts DESC LIMIT 200");
    const w = await workerStatus(ctx);
    return { snapshot: snap, breakers: w.status?.breakers ?? [], events, settings: ctx.store.get() };
  });

  f.get("/api/wallet", async () => {
    // public data only: address and balances — the private key never leaves the worker's signer
    const w = await workerStatus(ctx);
    const row = await ctx.db.one("SELECT address, last_balance_lamports, last_balance_at, token_balances FROM wallets ORDER BY last_balance_at DESC NULLS LAST LIMIT 1");
    const checks = await ctx.db.many("SELECT ts, onchain_lamports, expected_lamports, matched, note FROM balance_checks ORDER BY ts DESC LIMIT 20");
    return { wallet: w.status?.wallet ?? null, stored: row, balanceChecks: checks, solEur: w.status?.solEur ?? null };
  });

  f.get("/api/logs", async (req) => {
    const q = z.object({ category: z.string().max(40).optional(), level: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.category) where.push(`category = $${params.push(q.category)}`);
    if (q.level) where.push(`level = $${params.push(q.level)}`);
    params.push(q.limit);
    return ctx.db.many(`SELECT * FROM system_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT $${params.length}`, params);
  });

  f.get("/api/notifications", async () => ctx.db.many("SELECT * FROM notifications ORDER BY ts DESC LIMIT 200"));
  f.get("/api/settings", async () => ({ settings: ctx.store.get(), audit: await ctx.db.many("SELECT id, ts, actor FROM settings_audit ORDER BY ts DESC LIMIT 50") }));
  f.get("/api/watchlist", async () => ctx.db.many("SELECT w.mint, w.note, w.created_at, t.symbol, t.safe, t.safety_reasons FROM watchlist w LEFT JOIN tokens t ON t.mint = w.mint ORDER BY w.created_at"));
  f.get("/api/positions", async () => {
    // arbitrage is atomic: open positions are only in-flight executions and token dust in the wallet
    const inflight = await ctx.db.many("SELECT * FROM execution_attempts WHERE status IN ('DETECTED','SIMULATED','SUBMITTED') ORDER BY created_at DESC LIMIT 50");
    const wallet = await ctx.db.one<{ token_balances: unknown }>("SELECT token_balances FROM wallets ORDER BY last_balance_at DESC NULLS LAST LIMIT 1");
    return { inflight, holdings: wallet?.token_balances ?? [] };
  });
  f.get("/api/orders", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return ctx.db.many("SELECT * FROM execution_attempts ORDER BY created_at DESC LIMIT $1", [limit]);
  });
}
