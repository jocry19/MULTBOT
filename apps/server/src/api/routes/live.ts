import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../../app/app.js";
import { requireConfiguredAuth, type AuthPolicy } from "../auth.js";
import { portfolio } from "../../modules/portfolio/portfolio.js";
import { TAX_DISCLAIMER } from "../../modules/tax/taxLedger.js";

export async function registerLiveRoutes(f: FastifyInstance, app: App, policy: AuthPolicy): Promise<void> {
  const moneyGuard = requireConfiguredAuth(policy);

  // --- bot wallet ---------------------------------------------------------------------------
  f.get("/api/wallet", async () => {
    const s = app.state.get();
    const lamports = app.wallet.lamports;
    const pf = await portfolio(app.db, app.indexer.market, "live", { walletLamports: lamports });
    return {
      configured: Boolean(app.wallet.signer),
      error: app.wallet.signer ? null : app.wallet.loadError,
      address: app.wallet.address,
      explorer: app.wallet.address ? { solscan: `https://solscan.io/account/${app.wallet.address}`, solanaFm: `https://solana.fm/address/${app.wallet.address}` } : null,
      balanceSol: lamports === null ? null : lamports / 1e9,
      reserveSol: s.risk.minWalletReserveSol,
      tradingCapitalSol: lamports === null ? null : Math.max(0, lamports / 1e9 - s.risk.minWalletReserveSol),
      holdings: [...app.wallet.holdings.values()].map((h) => ({ mint: h.mint, account: h.account, amount: h.raw.toString(), ui: h.ui, decimals: h.decimals })),
      portfolio: { ...pf, positions: undefined },
      updatedAt: app.wallet.balanceAt,
    };
  });

  f.get("/api/wallet/transactions", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return app.db.many("SELECT * FROM transactions WHERE wallet = $1 ORDER BY slot DESC LIMIT $2", [app.wallet.address ?? "", q.limit]);
  });

  f.post("/api/wallet/refresh", async () => {
    await app.wallet.refresh();
    await app.wallet.syncHistory();
    return { ok: true };
  });

  /** Send SOL from the bot wallet (withdrawal). Requires configured auth + typed confirmation. */
  f.post("/api/wallet/send", { preHandler: moneyGuard }, async (req) => {
    const b = z.object({ to: z.string().min(32).max(44), amountSol: z.number().positive().max(10_000), confirm: z.literal("SEND") }).parse(req.body);
    return app.wallet.sendSol(b.to, b.amountSol, app.live.openPositions.length);
  });

  // --- live trading ---------------------------------------------------------------------------
  f.get("/api/live/positions", async () => {
    const pf = await portfolio(app.db, app.indexer.market, "live", { walletLamports: app.wallet.lamports });
    return pf.positions;
  });

  f.get("/api/live/trades", async (req) => {
    const q = z.object({ status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return app.db.many(
      `SELECT l.*, t.symbol, t.name FROM live_trades l LEFT JOIN tokens t ON t.mint = l.mint ${q.status ? "WHERE l.status = $2" : ""} ORDER BY l.decision_ts DESC LIMIT $1`,
      q.status ? [q.limit, q.status] : [q.limit],
    );
  });

  f.get("/api/live/trades/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const trade = await app.db.one<{ signal_id: string | null }>("SELECT * FROM live_trades WHERE id = $1", [id]);
    const [orders, signal, ledger, learning] = await Promise.all([
      app.db.many("SELECT * FROM orders WHERE live_trade_id = $1 ORDER BY created_at", [id]),
      trade?.signal_id ? app.db.one("SELECT * FROM signals WHERE id = $1", [trade.signal_id]) : Promise.resolve(null),
      app.db.many("SELECT * FROM ledger_entries WHERE trade_id = $1 ORDER BY id", [id]),
      app.db.one("SELECT * FROM learning_updates WHERE mode = 'live' AND trade_id = $1", [id]),
    ]);
    return { trade, orders, signal, ledger, learning };
  });

  f.post("/api/live/positions/:id/close", { preHandler: moneyGuard }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { closed: await app.live.closeById(id) };
  });

  f.post("/api/live/positions/close-all", { preHandler: moneyGuard }, async (req) => {
    z.object({ confirm: z.literal("CLOSE ALL") }).parse(req.body);
    app.activity.warn("control", "Close all live positions requested by user");
    return { closing: await app.live.closeAll("MANUAL") };
  });

  f.get("/api/orders", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return app.db.many(
      "SELECT id, live_trade_id, kind, mint, status, provider, input_amount, min_output_amount, signature, attempts, sent_at, confirmed_at, error, created_at, cost_estimate, result FROM orders ORDER BY created_at DESC LIMIT $1",
      [q.limit],
    );
  });

  f.get("/api/ledger", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return app.db.many("SELECT * FROM ledger_entries ORDER BY id DESC LIMIT $1", [q.limit]);
  });
  f.get("/api/ledger/verify", async () => app.ledger.verify());

  // --- German tax documentation --------------------------------------------------------------
  f.get("/api/tax/summary", async (req) => {
    const q = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() }).parse(req.query);
    const year = q.year ?? new Date().getUTCFullYear();
    const r = await app.db.one<{ disposals: number; gains: number | null; losses: number | null; unknown: number }>(
      `SELECT count(*)::int8 AS disposals, sum(gain_eur) FILTER (WHERE gain_eur > 0) AS gains, sum(gain_eur) FILTER (WHERE gain_eur < 0) AS losses,
              count(*) FILTER (WHERE gain_eur IS NULL AND kind <> 'transfer')::int8 AS unknown
         FROM tax_disposals WHERE disposed_at >= $1 AND disposed_at < $2`,
      [new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1))],
    );
    return { year, disclaimer: TAX_DISCLAIMER, ...r };
  });

  f.get("/api/tax/export", async (req, reply) => {
    const q = z.object({ format: z.enum(["csv", "json", "xlsx"]).default("csv"), year: z.coerce.number().int().min(2020).max(2100).optional() }).parse(req.query);
    const name = `multbot-steuer-${q.year ?? "alle"}`;
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`);
      return app.tax.exportCsv(q.year);
    }
    if (q.format === "json") {
      reply.header("content-type", "application/json").header("content-disposition", `attachment; filename="${name}.json"`);
      return app.tax.exportJson(q.year);
    }
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition", `attachment; filename="${name}.xlsx"`);
    return reply.send(await app.tax.exportXlsx(q.year));
  });

  f.post("/api/tax/declare-cost-basis", { preHandler: moneyGuard }, async (req) => {
    const b = z.object({ lotId: z.number().int(), costEur: z.number().min(0) }).parse(req.body);
    await app.db.query("UPDATE tax_lots SET cost_eur = $2, notes = 'declared by user' WHERE id = $1 AND source = 'deposit'", [b.lotId, b.costEur]);
    return { ok: true };
  });
  f.get("/api/tax/lots", async () => app.db.many("SELECT * FROM tax_lots ORDER BY acquired_at DESC LIMIT 500"));
}
