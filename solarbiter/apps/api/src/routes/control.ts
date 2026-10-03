import { STATE_KEYS } from "@solarbiter/database";
import {
  CIRCUIT_BREAKERS,
  DEFAULT_EMERGENCY,
  DEFAULT_LIVE_GATE,
  LIVE_CONFIRMATION_PHRASE,
  isRiskNotIncreased,
  mergeSettings,
  type BotControlState,
  type EmergencyState,
  type LiveGateRecord,
} from "@solarbiter/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { control, workerStatus, type ApiContext } from "../context.js";

const actorOf = (req: FastifyRequest): string => req.user?.username ?? "unknown";

async function requirePassword(ctx: ApiContext, req: FastifyRequest, reply: FastifyReply, password: string | undefined): Promise<boolean> {
  if (!req.user || !password || !(await ctx.auth.checkPassword(req.user.id, password))) {
    await reply.code(403).send({ error: "password confirmation required for this action" });
    return false;
  }
  return true;
}

export async function registerControlRoutes(f: FastifyInstance, ctx: ApiContext): Promise<void> {
  const gate = () => ctx.store.getState<LiveGateRecord>(STATE_KEYS.liveGate, DEFAULT_LIVE_GATE);
  const emergency = () => ctx.store.getState<EmergencyState>(STATE_KEYS.emergency, DEFAULT_EMERGENCY);
  const reload = async () => {
    await ctx.store.reloadState();
    await ctx.store.refresh();
  };

  // --- bot ----------------------------------------------------------------------------------------
  f.post("/api/bot/start", async (req) => {
    await reload();
    const s: BotControlState = { desired: "RUNNING", reason: null, at: Date.now(), by: actorOf(req) };
    await control(ctx, { type: "BOT_START" }, [[STATE_KEYS.bot, s]], actorOf(req));
    return { ok: true, note: "Bot runs in PAPER (or SHADOW if enabled). Live trading needs the live gate + manual unlock." };
  });

  f.post("/api/bot/stop", async (req) => {
    const { reason } = z.object({ reason: z.string().max(200).default("stopped by user") }).parse(req.body ?? {});
    const s: BotControlState = { desired: "PAUSED", reason, at: Date.now(), by: actorOf(req) };
    await control(ctx, { type: "BOT_STOP" }, [[STATE_KEYS.bot, s]], actorOf(req));
    return { ok: true };
  });

  f.post("/api/bot/shadow", async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await control(ctx, { type: "SHADOW_SET", enabled }, [[STATE_KEYS.shadow, enabled]], actorOf(req));
    return { ok: true, note: enabled ? "SHADOW needs a configured, funded bot wallet (simulation only — nothing is sent)." : "PAPER" };
  });

  // --- live ---------------------------------------------------------------------------------------
  f.post("/api/live/enable", async (req, reply) => {
    const body = z.object({ confirmation: z.string(), password: z.string().min(1).max(500) }).parse(req.body);
    await reload();
    const reasons: string[] = [];
    if (body.confirmation !== LIVE_CONFIRMATION_PHRASE) reasons.push(`type exactly "${LIVE_CONFIRMATION_PHRASE}"`);
    if (!ctx.config.liveMode) reasons.push("LIVE_MODE=false in the environment (hard switch)");
    if (gate().state !== "LIVE_READY") reasons.push(`live gate is ${gate().state} — validation not passed yet`);
    if (emergency().active) reasons.push("EMERGENCY STOP is active");
    const w = await workerStatus(ctx);
    if (!w.online) reasons.push("worker offline");
    if (!w.status?.wallet.configured) reasons.push("no bot wallet configured");
    const open = (w.status?.breakers ?? []).filter((b) => b.open);
    if (open.length) reasons.push(`circuit breakers open: ${open.map((b) => b.id).join(", ")}`);
    if (reasons.length) return reply.code(409).send({ error: "live trading cannot be enabled", reasons });
    if (!(await requirePassword(ctx, req, reply, body.password))) return;
    const g: LiveGateRecord = { ...gate(), state: "LIVE_ENABLED", enabledAt: Date.now(), enabledBy: actorOf(req), stoppedReason: null };
    await control(ctx, { type: "LIVE_ENABLE", actor: actorOf(req) }, [[STATE_KEYS.liveGate, g]], actorOf(req));
    return { ok: true, level: ctx.store.get().risk.liveLevel, maxTradeEur: ctx.store.get().risk.liveLevelMaxTradeEur[ctx.store.get().risk.liveLevel - 1] };
  });

  f.post("/api/live/disable", async (req) => {
    await reload();
    const g: LiveGateRecord = { ...gate(), state: "LIVE_LOCKED", stoppedReason: `disabled by ${actorOf(req)}` };
    await control(ctx, { type: "LIVE_DISABLE", actor: actorOf(req) }, [[STATE_KEYS.liveGate, g]], actorOf(req));
    return { ok: true };
  });

  f.post("/api/live/level", async (req, reply) => {
    const body = z.object({ level: z.number().int().min(1).max(4), password: z.string().max(500).optional() }).parse(req.body);
    await reload();
    const current = ctx.store.get().risk.liveLevel;
    if (body.level > current) {
      // raising risk is ALWAYS a manual, evidence-based step: one level at a time, eligibility + password
      const elig = ctx.store.getState<{ eligible: boolean; next: number | null; reasons: string[] } | null>(STATE_KEYS.levelEligibility, null);
      if (body.level !== current + 1) return reply.code(409).send({ error: "levels can only be raised one at a time" });
      if (!elig?.eligible || elig.next !== body.level) return reply.code(409).send({ error: "level not eligible yet", reasons: elig?.reasons ?? ["no live statistics yet"] });
      if (!(await requirePassword(ctx, req, reply, body.password))) return;
    }
    await ctx.store.update({ risk: { liveLevel: body.level } }, `user:${actorOf(req)}`);
    await control(ctx, { type: "LIVE_LEVEL_SET", level: body.level, actor: actorOf(req) }, [], actorOf(req));
    return { ok: true, level: body.level };
  });

  // --- emergency stop -------------------------------------------------------------------------------
  f.post("/api/emergency-stop", async (req) => {
    const { reason } = z.object({ reason: z.string().max(300).default("manual emergency stop") }).parse(req.body ?? {});
    await reload();
    // stop new trades, disable live, keep every log and state
    const e: EmergencyState = { active: true, reason, at: Date.now(), by: actorOf(req) };
    const g: LiveGateRecord = { ...gate(), state: "LIVE_LOCKED", stoppedReason: `EMERGENCY STOP: ${reason}` };
    await control(ctx, { type: "EMERGENCY_STOP", reason }, [
      [STATE_KEYS.emergency, e],
      [STATE_KEYS.liveGate, g],
    ], actorOf(req));
    const w = await workerStatus(ctx);
    return { ok: true, wallet: w.status?.wallet ?? null };
  });

  f.post("/api/emergency-release", async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(500) }).parse(req.body);
    if (!(await requirePassword(ctx, req, reply, password))) return;
    await control(ctx, { type: "EMERGENCY_RELEASE" }, [[STATE_KEYS.emergency, { ...DEFAULT_EMERGENCY }]], actorOf(req));
    return { ok: true, note: "Emergency stop released. Live trading stays locked until enabled again." };
  });

  // --- breakers, learning, wallet -------------------------------------------------------------------
  f.post("/api/breakers/:id/reset", async (req) => {
    const { id } = z.object({ id: z.enum(CIRCUIT_BREAKERS) }).parse(req.params);
    await control(ctx, { type: "BREAKER_RESET", breaker: id, actor: actorOf(req) }, [], actorOf(req));
    return { ok: true };
  });
  f.post("/api/learning/optimize", async (req) => {
    await control(ctx, { type: "RUN_OPTIMIZATION" }, [], actorOf(req));
    return { ok: true };
  });
  f.post("/api/wallet/refresh", async (req) => {
    await control(ctx, { type: "REFRESH_WALLET" }, [], actorOf(req));
    return { ok: true };
  });

  // --- settings -------------------------------------------------------------------------------------
  f.put("/api/settings", async (req, reply) => {
    const body = z.object({ patch: z.record(z.string(), z.unknown()), password: z.string().max(500).optional() }).parse(req.body);
    await reload();
    const prev = ctx.store.get();
    const next = mergeSettings(prev, body.patch); // throws (400) on invalid values
    if (next.risk.liveLevel !== prev.risk.liveLevel) return reply.code(409).send({ error: "change the live level via /api/live/level" });
    if (next.risk.emergencyStop !== prev.risk.emergencyStop) return reply.code(409).send({ error: "use /api/emergency-stop" });
    if (!isRiskNotIncreased(prev, next)) {
      // raising a risk limit is allowed only as an explicit, password-confirmed user action
      if (!(await requirePassword(ctx, req, reply, body.password))) return;
    }
    const saved = await ctx.store.update(body.patch, `user:${actorOf(req)}`);
    await control(ctx, { type: "SETTINGS_CHANGED" }, [], actorOf(req));
    return { ok: true, settings: saved };
  });

  // --- watchlist / notifications --------------------------------------------------------------------
  f.post("/api/watchlist", async (req) => {
    const { mint, note } = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), note: z.string().max(100).default("") }).parse(req.body);
    await ctx.db.query("INSERT INTO watchlist (mint, note) VALUES ($1, $2) ON CONFLICT (mint) DO UPDATE SET note = EXCLUDED.note", [mint, note]);
    return { ok: true, note: "Only tokens of the verified list are traded; watchlist entries are shown and safety-checked." };
  });
  f.delete("/api/watchlist/:mint", async (req) => {
    const { mint } = z.object({ mint: z.string().max(60) }).parse(req.params);
    await ctx.db.query("DELETE FROM watchlist WHERE mint = $1", [mint]);
    return { ok: true };
  });
  f.post("/api/notifications/read", async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(500).optional() }).parse(req.body ?? {});
    if (ids?.length) await ctx.db.query("UPDATE notifications SET read = true WHERE id = ANY($1::bigint[])", [ids]);
    else await ctx.db.query("UPDATE notifications SET read = true WHERE NOT read");
    return { ok: true };
  });
}
