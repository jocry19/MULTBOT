import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../../app/app.js";
import { portfolio } from "../../modules/portfolio/portfolio.js";
import { performance } from "../../modules/stats/stats.js";

export async function registerPaperRoutes(f: FastifyInstance, app: App): Promise<void> {
  /** The big paper-trading scoreboard + strategy competition. */
  f.get("/api/paper/summary", async () => {
    const s = app.state.get();
    const pf = await portfolio(app.db, app.indexer.market, "paper", { paperCapitalSol: s.trading.paperCapitalSol });
    const closed = await app.db.many<{ net_pnl_sol: number }>("SELECT net_pnl_sol FROM paper_trades WHERE status IN ('CLOSED','FAILED') AND net_pnl_sol IS NOT NULL ORDER BY closed_at");
    const stats = performance(closed.map((r) => r.net_pnl_sol));
    const competition = await app.db.many<{ strategy_id: string; name: string; status: string; pnl: number[] }>(
      `SELECT p.strategy_id, s.name, s.status, array_agg(p.net_pnl_sol ORDER BY p.closed_at) AS pnl
         FROM paper_trades p JOIN strategies s ON s.id = p.strategy_id
        WHERE p.status IN ('CLOSED','FAILED') AND p.net_pnl_sol IS NOT NULL GROUP BY p.strategy_id, s.name, s.status`,
    );
    const freq = await app.db.many<{ strategy_id: string; per_hour: number }>(
      `SELECT strategy_id, count(*) / GREATEST(1, EXTRACT(EPOCH FROM (max(decision_ts) - min(decision_ts))) / 3600.0) AS per_hour
         FROM paper_trades GROUP BY strategy_id`,
    );
    const freqMap = new Map(freq.map((x) => [x.strategy_id, x.per_hour]));
    return {
      portfolio: { ...pf, positions: undefined },
      stats,
      competition: competition
        .map((c) => {
          const p = performance(c.pnl);
          return {
            strategyId: c.strategy_id,
            name: c.name,
            status: c.status,
            trades: p.n,
            expectancy: p.mean,
            winRate: p.winRate,
            profitFactor: Number.isFinite(p.profitFactor) ? p.profitFactor : null,
            maxDrawdown: p.maxDrawdown,
            tailLoss: p.tailLoss,
            netSol: p.sum,
            stability: p.std > 0 ? p.mean / p.std : null,
            tradesPerHour: freqMap.get(c.strategy_id) ?? null,
            pValue: p.pValue,
          };
        })
        .sort((a, b) => b.expectancy - a.expectancy),
    };
  });

  f.get("/api/paper/positions", async () => {
    const s = app.state.get();
    const pf = await portfolio(app.db, app.indexer.market, "paper", { paperCapitalSol: s.trading.paperCapitalSol });
    return pf.positions;
  });

  f.get("/api/paper/trades", async (req) => {
    const q = z
      .object({ status: z.enum(["OPEN", "CLOSED", "FAILED", "OPENING"]).optional(), strategyId: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [q.limit];
    if (q.status) {
      params.push(q.status);
      where.push(`p.status = $${params.length}`);
    }
    if (q.strategyId) {
      params.push(q.strategyId);
      where.push(`p.strategy_id = $${params.length}`);
    }
    return app.db.many(
      `SELECT p.*, t.symbol, t.name FROM paper_trades p LEFT JOIN tokens t ON t.mint = p.mint
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.decision_ts DESC LIMIT $1`,
      params,
    );
  });

  f.get("/api/paper/trades/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const trade = await app.db.one<{ signal_id: string | null }>("SELECT p.*, t.symbol, t.name FROM paper_trades p LEFT JOIN tokens t ON t.mint = p.mint WHERE p.id = $1", [id]);
    const signal = trade?.signal_id ? await app.db.one("SELECT * FROM signals WHERE id = $1", [trade.signal_id]) : null;
    const learning = await app.db.one("SELECT * FROM learning_updates WHERE mode = 'paper' AND trade_id = $1", [id]);
    return { trade, signal, learning };
  });

  f.get("/api/signals", async (req) => {
    const q = z.object({ mode: z.enum(["paper", "live"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return app.db.many(
      `SELECT s.id, s.mode, s.strategy_id, s.strategy_version_id, s.mint, s.ts, s.decision, s.reasons, s.expected, t.symbol
         FROM signals s LEFT JOIN tokens t ON t.mint = s.mint ${q.mode ? "WHERE s.mode = $2" : ""} ORDER BY s.ts DESC LIMIT $1`,
      q.mode ? [q.limit, q.mode] : [q.limit],
    );
  });
}
