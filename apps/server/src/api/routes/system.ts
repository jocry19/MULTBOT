import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ComponentStatus, SystemHealthDto } from "@multbot/shared";
import type { App } from "../../app/app.js";
import { requireConfiguredAuth, type AuthPolicy } from "../auth.js";
import { BOT_STATE_KEY, LIVE_STATE_KEY } from "../../modules/live/liveEngine.js";
import { portfolio } from "../../modules/portfolio/portfolio.js";

export async function buildHealth(app: App): Promise<SystemHealthDto> {
  const modules = [...app.registry.health(), ...app.research.workerHealth];
  const db: ComponentStatus = app.db.isHealthy ? "CONNECTED" : "DISCONNECTED";
  return {
    rpc: app.rpc.componentStatus(),
    dataFeed: app.config.features.ingest ? app.stream.componentStatus() : "DISABLED",
    database: db,
    wallet: app.wallet.componentStatus(),
    tradingEngine: app.live.engineState,
    paperEngine: app.state.get().trading.paperTradingEnabled ? "RUNNING" : "PAUSED",
    liveTrading: app.live.liveState,
    reconciliation: app.live.reconciliation,
    emergencyStop: app.state.get().risk.emergencyStop,
    modules: modules.map((m) => ({ name: m.name, state: m.state, status: m.status, ...(m.detail ? { detail: m.detail } : {}), lastError: m.lastError ?? null })),
    rpcEndpoints: app.rpc.endpointHealth().map((e) => ({
      name: e.name,
      kind: e.kind,
      status: e.status,
      latencyMs: e.latencyMs,
      slot: e.slot,
      slotLag: e.slotLag,
      wsConnected: app.ws.isConnected && app.ws.currentEndpoint === e.name,
      errorRate: e.errorRate,
      requests: e.requests,
    })),
    ingest: {
      lastEventAt: app.stream.lastEventAt ? new Date(app.stream.lastEventAt).toISOString() : null,
      eventsPerMinute: app.stream.eventsPerMinute(),
      decodeErrors: app.stream.decodeErrors,
    },
    serverTime: new Date().toISOString(),
  };
}

export async function registerSystemRoutes(f: FastifyInstance, app: App, policy: AuthPolicy): Promise<void> {
  const moneyGuard = requireConfiguredAuth(policy);

  f.get("/api/health", async () => buildHealth(app));

  f.get("/api/dashboard", async () => {
    const s = app.state.get();
    const [live, paper, counts, regime] = await Promise.all([
      portfolio(app.db, app.indexer.market, "live", { walletLamports: app.wallet.lamports }),
      portfolio(app.db, app.indexer.market, "paper", { paperCapitalSol: s.trading.paperCapitalSol }),
      app.db.one<{ active: number; paper: number; live: number; validated: number }>(
        `SELECT (SELECT count(*) FROM strategies WHERE status IN ('PAPER_TRADING','PAPER_VALIDATED','LIVE_ENABLED','DEGRADED'))::int8 AS active,
                (SELECT count(*) FROM paper_trades)::int8 AS paper,
                (SELECT count(*) FROM live_trades)::int8 AS live,
                (SELECT count(*) FROM strategies WHERE status IN ('PAPER_VALIDATED','LIVE_ENABLED'))::int8 AS validated`,
      ),
      Promise.resolve(app.indexer.regime.state),
    ]);
    return {
      wallet: {
        address: app.wallet.address,
        balanceSol: app.wallet.lamports === null ? null : app.wallet.lamports / 1e9,
        availableSol: app.wallet.lamports === null ? null : Math.max(0, app.wallet.lamports / 1e9 - s.risk.minWalletReserveSol),
        lockedSol: live.lockedSol,
        reserveSol: s.risk.minWalletReserveSol,
      },
      live: { ...live, positions: undefined },
      paper: { ...paper, positions: undefined },
      strategies: { active: counts?.active ?? 0, validated: counts?.validated ?? 0 },
      trades: { paper: counts?.paper ?? 0, live: counts?.live ?? 0 },
      regime: regime ? { label: regime.label, levels: regime.levels, metrics: regime.metrics } : null,
      bot: { running: app.live.botRunning, liveState: app.live.liveState, emergencyStop: s.risk.emergencyStop, reconciliation: app.live.reconciliation },
      market: { tokens: app.indexer.market.tokens.size, eventsPerMinute: app.stream.eventsPerMinute() },
    };
  });

  f.get("/api/activity", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), category: z.string().optional() }).parse(req.query);
    return app.db.many(
      `SELECT id, ts, level, category, message, data FROM bot_activity ${q.category ? "WHERE category = $2" : ""} ORDER BY id DESC LIMIT $1`,
      q.category ? [q.limit, q.category] : [q.limit],
    );
  });

  f.get("/api/notifications", async () => app.db.many("SELECT * FROM notifications ORDER BY ts DESC LIMIT 100"));

  f.get("/api/settings", async () => app.state.get());

  f.put("/api/settings", async (req) => {
    const next = await app.state.update(req.body as never, "user");
    app.activity.info("settings", "Settings updated by user");
    return next;
  });

  f.get("/api/settings/audit", async () => app.db.many("SELECT id, ts, actor, old_value, new_value FROM settings_audit ORDER BY id DESC LIMIT 50"));

  f.get("/api/regime", async () => ({
    current: app.indexer.regime.state,
    history: await app.db.many("SELECT ts, label, levels, metrics FROM market_regimes WHERE ts > now() - interval '24 hours' ORDER BY ts"),
  }));

  // --- manual overrides -------------------------------------------------------------------
  f.post("/api/bot/start", async () => {
    await app.state.setState(BOT_STATE_KEY, { running: true, changedAt: new Date().toISOString() });
    app.activity.success("control", "Bot started by user");
    return { running: true };
  });
  f.post("/api/bot/stop", async () => {
    await app.state.setState(BOT_STATE_KEY, { running: false, changedAt: new Date().toISOString() });
    app.activity.warn("control", "Bot stopped by user (no new live entries; exits continue)");
    return { running: false };
  });
  f.post("/api/bot/pause-entries", async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await app.state.update({ risk: { pauseEntries: paused } }, "user");
    app.activity.info("control", paused ? "Entries paused by user" : "Entries resumed by user");
    return { pauseEntries: paused };
  });
  f.post("/api/bot/pause-exits", async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await app.state.update({ risk: { pauseExits: paused } }, "user");
    app.activity.warn("control", paused ? "Automatic exits paused by user" : "Automatic exits resumed by user");
    return { pauseExits: paused };
  });
  f.post("/api/bot/emergency-stop", async (req) => {
    const b = z.object({ active: z.boolean(), closePositions: z.boolean().optional() }).parse(req.body);
    await app.state.update({ risk: { emergencyStop: b.active, ...(b.closePositions !== undefined ? { emergencyStopClosePositions: b.closePositions } : {}) } }, "user");
    return { emergencyStop: b.active };
  });

  // --- real money mode (user action only) --------------------------------------------------
  f.get("/api/live/status", async () => {
    const validated = await app.db.many<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM strategies WHERE status IN ('PAPER_VALIDATED', 'LIVE_ENABLED') ORDER BY seq",
    );
    const reasons: string[] = [];
    if (!app.wallet.signer) reasons.push(app.wallet.loadError ?? "no bot wallet");
    if (validated.length === 0) reasons.push("Strategy validation incomplete (no PAPER_VALIDATED strategy)");
    if (!policy.enabled) reasons.push("Admin password not configured");
    if (app.live.reconciliation !== "OK") reasons.push("Reconciliation required");
    return { state: app.live.liveState, unlockable: reasons.length === 0, reasons, validatedStrategies: validated };
  });

  f.post("/api/live/unlock", { preHandler: moneyGuard }, async (req, reply) => {
    const b = z.object({ confirm: z.literal("ENABLE REAL TRADING") }).parse(req.body);
    void b;
    if (!app.wallet.signer) return reply.code(400).send({ error: "bot wallet not configured" });
    const validated = await app.db.one<{ n: number }>("SELECT count(*)::int8 AS n FROM strategies WHERE status IN ('PAPER_VALIDATED','LIVE_ENABLED')");
    if (!validated?.n) return reply.code(400).send({ error: "no validated strategy — real money mode stays locked" });
    await app.state.setState(LIVE_STATE_KEY, { state: "ACTIVE", activatedAt: new Date().toISOString(), activatedBy: "user" });
    app.activity.warn("live", "REAL MONEY MODE ACTIVATED by user");
    return { state: "ACTIVE" };
  });

  f.post("/api/live/lock", async () => {
    await app.state.setState(LIVE_STATE_KEY, { state: "LOCKED", lockedAt: new Date().toISOString(), lockedBy: "user" });
    app.activity.info("live", "Real money mode locked by user");
    return { state: "LOCKED" };
  });

  f.get("/api/reconciliation", async () => ({ state: app.live.reconciliation, issues: app.reconciler.issues, lastRunAt: app.reconciler.lastRunAt }));
  f.post("/api/reconciliation/run", async () => app.reconciler.run());
  f.post("/api/reconciliation/acknowledge", { preHandler: moneyGuard }, async () => {
    await app.reconciler.acknowledge();
    return { ok: true };
  });
}
