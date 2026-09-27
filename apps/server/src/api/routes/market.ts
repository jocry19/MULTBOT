import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../../app/app.js";
import { computeFeatures } from "../../modules/features/featureEngine.js";
import { contextKey } from "../../modules/anomaly/baselines.js";
import { applyDerived } from "../../modules/features/derived.js";
import { matchSpec } from "../../modules/strategy/evaluate.js";
import { profileFromTotals } from "../../modules/wallets/walletBook.js";
import { discoveryLabel } from "../../modules/market/indexer.js";

const limitSchema = z.coerce.number().int().min(1).max(500);

export async function registerMarketRoutes(f: FastifyInstance, app: App): Promise<void> {
  f.get("/api/markets", async (req) => {
    const q = z
      .object({
        sort: z.enum(["discovery", "volume", "new", "change", "mcap"]).default("volume"),
        venue: z.enum(["pump_curve", "pump_amm", "all"]).default("all"),
        limit: limitSchema.default(100),
        search: z.string().max(60).optional(),
      })
      .parse(req.query);
    const order = {
      discovery: "s.discovery_score DESC NULLS LAST",
      volume: "s.volume_sol_5m DESC NULLS LAST",
      new: "t.created_at DESC NULLS LAST",
      change: "s.price_change_5m DESC NULLS LAST",
      mcap: "s.market_cap_sol DESC NULLS LAST",
    }[q.sort];
    const params: unknown[] = [q.limit];
    let where = "s.last_trade_at > now() - interval '1 hour'";
    if (q.venue !== "all") {
      params.push(q.venue);
      where += ` AND s.venue = $${params.length}`;
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where += ` AND (t.symbol ILIKE $${params.length} OR t.name ILIKE $${params.length} OR s.mint ILIKE $${params.length})`;
    }
    return app.db.many(
      `SELECT s.*, t.name, t.symbol, t.created_at, t.creator, t.is_mayhem_mode
         FROM token_state s LEFT JOIN tokens t ON t.mint = s.mint
        WHERE ${where} ORDER BY ${order} LIMIT $1`,
      params,
    );
  });

  f.get("/api/discoveries", async (req) => {
    const q = z.object({ limit: limitSchema.default(50) }).parse(req.query);
    return app.db.many(
      `SELECT s.mint, s.venue, s.price_sol, s.market_cap_sol, s.liquidity_sol, s.volume_sol_5m, s.price_change_5m, s.holders,
              s.discovery_score, s.discovery_reasons, s.updated_at, t.name, t.symbol, t.created_at
         FROM token_state s LEFT JOIN tokens t ON t.mint = s.mint
        WHERE s.discovery_score > 0.5 AND s.updated_at > now() - interval '15 minutes'
        ORDER BY s.discovery_score DESC LIMIT $1`,
      [q.limit],
    );
  });

  f.get("/api/tokens/:mint", async (req, reply) => {
    const { mint } = z.object({ mint: z.string().min(20).max(60) }).parse(req.params);
    const [token, state, creator, events, holders, paper, live] = await Promise.all([
      app.db.one("SELECT * FROM tokens WHERE mint = $1", [mint]),
      app.db.one("SELECT * FROM token_state WHERE mint = $1", [mint]),
      app.db.one("SELECT c.* FROM creators c JOIN tokens t ON t.creator = c.address WHERE t.mint = $1", [mint]),
      app.db.many("SELECT id, type, ts, severity, direction, context, outcome FROM events WHERE mint = $1 ORDER BY ts DESC LIMIT 100", [mint]),
      app.db.many("SELECT owner, balance, first_acquired_at, last_change_at FROM holders WHERE mint = $1 ORDER BY balance DESC LIMIT 25", [mint]),
      app.db.many("SELECT id, strategy_id, status, opened_at, closed_at, net_pnl_sol, net_return, exit_reason FROM paper_trades WHERE mint = $1 ORDER BY decision_ts DESC LIMIT 20", [mint]),
      app.db.many("SELECT id, strategy_id, status, opened_at, closed_at, net_pnl_sol, net_return, exit_reason FROM live_trades WHERE mint = $1 ORDER BY decision_ts DESC LIMIT 20", [mint]),
    ]);
    if (!token && !state) return reply.code(404).send({ error: "token not found" });
    const t = app.indexer.market.tokens.get(mint);
    let features: Record<string, number> | null = null;
    let strategyMatches: unknown[] = [];
    let analogues: unknown = null;
    if (t) {
      const now = Date.now();
      const fv = computeFeatures(t, app.indexer.market, now, {
        wallets: app.wallets,
        creators: app.wallets,
        eventAges: app.indexer.events.eventAges(mint, now),
        market: app.indexer.regime.features(),
      });
      app.indexer.baselines.transform(fv, contextKey(t.ageAt(now), t.venue));
      features = fv;
      const active = await app.strategies.activeForPaper();
      strategyMatches = active
        .map(({ strategy, version }) => {
          const m = matchSpec(version.spec, fv, t.venue, t.ageAt(now));
          return { strategyId: strategy.id, name: strategy.name, status: strategy.status, matched: m.matched, similarity: m.similarity, conditions: m.details };
        })
        .sort((a, b) => b.similarity - a.similarity);
      analogues = await app.research.request("analogues", { features: fv, venue: t.venue, ageSec: t.ageAt(now) }, 10_000).catch(() => null);
      void applyDerived;
    }
    return {
      token,
      state,
      creator,
      holders,
      events: events.map((e) => ({ ...e, label: discoveryLabel(String((e as { type: string }).type)) })),
      features,
      strategyMatches,
      analogues,
      trades: { paper, live },
      live: t
        ? {
            venue: t.venue,
            price: t.lastPrice,
            liquiditySol: t.liquiditySol,
            marketCapSol: t.marketCapSol,
            bondingProgress: t.bondingProgress,
            holders: t.holderCount(),
            trades: t.trades,
            buys: t.buys,
            sells: t.sells,
            athPrice: t.athPrice,
            seenFromCreation: t.seenFromCreation,
          }
        : null,
    };
  });

  f.get("/api/tokens/:mint/candles", async (req) => {
    const { mint } = z.object({ mint: z.string().min(20).max(60) }).parse(req.params);
    const q = z.object({ hours: z.coerce.number().min(0.1).max(168).default(6) }).parse(req.query);
    const rows = await app.db.many<{ ts: Date; open_price: number; high_price: number; low_price: number; close_price: number; buy_volume_sol: number; sell_volume_sol: number; buys: number; sells: number }>(
      `SELECT ts, open_price, high_price, low_price, close_price, buy_volume_sol, sell_volume_sol, buys, sells
         FROM volume_snapshots WHERE mint = $1 AND ts > now() - ($2 || ' hours')::interval ORDER BY ts`,
      [mint, String(q.hours)],
    );
    const candles = rows.map((r) => ({ t: r.ts.getTime(), o: r.open_price, h: r.high_price, l: r.low_price, c: r.close_price, bv: r.buy_volume_sol, sv: r.sell_volume_sol, n: r.buys + r.sells }));
    // merge in-memory bars (current minute and anything not yet persisted)
    const t = app.indexer.market.tokens.get(mint);
    if (t) {
      const last = candles[candles.length - 1]?.t ?? 0;
      for (const b of t.bars.bars) if (b.t > last) candles.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, bv: b.buyVol, sv: b.sellVol, n: b.buys + b.sells });
    }
    return candles;
  });

  f.get("/api/tokens/:mint/trades", async (req) => {
    const { mint } = z.object({ mint: z.string().min(20).max(60) }).parse(req.params);
    const q = z.object({ limit: limitSchema.default(100) }).parse(req.query);
    return app.db.many(
      `SELECT signature, ts, trader, is_buy, sol_amount, token_amount, price_sol, venue FROM market_trades
        WHERE mint = $1 AND ts > now() - interval '7 days' ORDER BY ts DESC LIMIT $2`,
      [mint, q.limit],
    );
  });

  f.get("/api/events", async (req) => {
    const q = z.object({ type: z.string().max(100).optional(), mint: z.string().max(60).optional(), limit: limitSchema.default(200) }).parse(req.query);
    const where: string[] = ["e.ts > now() - interval '24 hours'"];
    const params: unknown[] = [q.limit];
    if (q.type) {
      params.push(q.type);
      where.push(`e.type = $${params.length}`);
    }
    if (q.mint) {
      params.push(q.mint);
      where.push(`e.mint = $${params.length}`);
    }
    const rows = await app.db.many<{ type: string }>(
      `SELECT e.id, e.type, e.mint, e.ts, e.severity, e.direction, e.context, e.outcome, t.symbol
         FROM events e LEFT JOIN tokens t ON t.mint = e.mint WHERE ${where.join(" AND ")} ORDER BY e.ts DESC LIMIT $1`,
      params,
    );
    return rows.map((r) => ({ ...r, label: discoveryLabel(r.type) }));
  });

  f.get("/api/events/stats", async () =>
    app.db.many(
      `SELECT type, count(*)::int8 AS n,
              avg((outcome->'ret'->>'300')::float8) FILTER (WHERE outcome_complete) AS avg_ret_5m,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (outcome->'ret'->>'300')::float8) FILTER (WHERE outcome_complete AND outcome->'ret'->>'300' IS NOT NULL) AS median_ret_5m,
              avg(CASE WHEN (outcome->'ret'->>'300')::float8 > 0 THEN 1 ELSE 0 END) FILTER (WHERE outcome_complete AND outcome->'ret'->>'300' IS NOT NULL) AS positive_share
         FROM events WHERE ts > now() - interval '7 days' AND type NOT LIKE 'anomaly:%'
        GROUP BY type ORDER BY n DESC LIMIT 100`,
    ),
  );

  // --- wallet intelligence -----------------------------------------------------------------
  f.get("/api/wallets", async (req) => {
    const q = z.object({ sort: z.enum(["skill", "pnl", "trades", "early"]).default("skill"), limit: limitSchema.default(100) }).parse(req.query);
    const order = {
      skill: "(sum_return / NULLIF(closed_positions, 0)) DESC NULLS LAST",
      pnl: "realized_pnl_sol DESC",
      trades: "trade_count DESC",
      early: "early_entries DESC",
    }[q.sort];
    const rows = await app.db.many<Record<string, unknown>>(
      `SELECT * FROM wallets WHERE closed_positions >= ${q.sort === "skill" ? 10 : 1} ORDER BY ${order} LIMIT $1`,
      [q.limit],
    );
    return rows.map((r) => {
      const p = profileFromTotals(
        {
          firstSeenAt: (r.first_seen_at as Date).getTime(),
          lastSeenAt: (r.last_seen_at as Date).getTime(),
          trades: r.trade_count as number,
          buys: r.buy_count as number,
          sells: r.sell_count as number,
          tokensTraded: r.tokens_traded as number,
          volumeSol: r.volume_sol as number,
          realizedPnlSol: r.realized_pnl_sol as number,
          closedPositions: r.closed_positions as number,
          winningPositions: r.winning_positions as number,
          sumReturn: r.sum_return as number,
          sumReturnSq: r.sum_return_sq as number,
          sumHoldSec: r.sum_hold_sec as number,
          sumEntrySol: r.sum_entry_sol as number,
          earlyEntries: r.early_entries as number,
          tokensCreated: r.tokens_created as number,
        },
        (r.cluster_id as number | null) ?? null,
      );
      return {
        address: r.address,
        firstSeenAt: r.first_seen_at,
        trades: r.trade_count,
        tokensTraded: r.tokens_traded,
        volumeSol: r.volume_sol,
        realizedPnlSol: r.realized_pnl_sol,
        closedPositions: r.closed_positions,
        winRate: p.winRate,
        meanReturn: p.meanReturn,
        skill: p.skill,
        avgHoldSec: (r.closed_positions as number) > 0 ? (r.sum_hold_sec as number) / (r.closed_positions as number) : null,
        avgEntrySol: (r.tokens_traded as number) > 0 ? (r.sum_entry_sol as number) / (r.tokens_traded as number) : null,
        earlyEntryRate: p.earlyEntryRate,
        clusterId: r.cluster_id,
        tokensCreated: r.tokens_created,
      };
    });
  });

  f.get("/api/wallets/:address", async (req, reply) => {
    const { address } = z.object({ address: z.string().min(20).max(60) }).parse(req.params);
    const w = await app.db.one("SELECT * FROM wallets WHERE address = $1", [address]);
    if (!w) return reply.code(404).send({ error: "wallet not known" });
    const [positions, events, cluster] = await Promise.all([
      app.db.many("SELECT p.*, t.symbol FROM wallet_positions p LEFT JOIN tokens t ON t.mint = p.mint WHERE p.address = $1 ORDER BY p.last_trade_at DESC LIMIT 100", [address]),
      app.db.many("SELECT * FROM wallet_events WHERE address = $1 ORDER BY ts DESC LIMIT 50", [address]),
      app.db.one("SELECT c.* FROM wallet_clusters c JOIN wallets w ON w.cluster_id = c.id WHERE w.address = $1", [address]),
    ]);
    return { wallet: w, profile: app.wallets.profile(address) ?? null, positions, events, cluster };
  });

  f.get("/api/wallet-clusters", async () =>
    app.db.many("SELECT id, created_at, method, size, members[1:12] AS members, features, stats FROM wallet_clusters WHERE active ORDER BY size DESC LIMIT 100"),
  );
}
