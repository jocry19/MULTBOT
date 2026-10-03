import { toCsv, toJson, type TaxRow } from "@solarbiter/tax";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { paperEpochStart, type ApiContext } from "../context.js";

const bi = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));

/** Tax export and the chart datasets of the dashboard. */
export async function registerReportRoutes(f: FastifyInstance, ctx: ApiContext): Promise<void> {
  f.get("/api/tax/export", async (req, reply) => {
    const q = z.object({ format: z.enum(["csv", "json"]).default("csv"), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const from = q.from ? new Date(q.from) : new Date(0);
    const to = q.to ? new Date(q.to) : new Date();
    const rows = await ctx.db.many<Record<string, unknown>>("SELECT * FROM tax_transactions WHERE ts >= $1 AND ts <= $2 ORDER BY ts, id", [from.toISOString(), to.toISOString()]);
    const tax: TaxRow[] = rows.map((r) => ({
      ts: (r.ts as Date).getTime(),
      signature: r.signature as string,
      walletAddress: r.wallet_address as string,
      kind: r.kind as TaxRow["kind"],
      assetIn: (r.asset_in as string | null) ?? null,
      amountIn: bi(r.amount_in),
      assetInDecimals: (r.asset_in_decimals as number | null) ?? null,
      assetOut: (r.asset_out as string | null) ?? null,
      amountOut: bi(r.amount_out),
      assetOutDecimals: (r.asset_out_decimals as number | null) ?? null,
      eurValue: (r.eur_value as number | null) ?? null,
      eurPrice: Number(r.eur_price ?? 0),
      eurPriceTs: r.eur_price_ts ? (r.eur_price_ts as Date).getTime() : 0,
      fees: bi(r.fees),
      feeCurrency: (r.fee_currency as string | null) ?? null,
      feeEur: (r.fee_eur as number | null) ?? null,
      acquisitionValueEur: (r.acquisition_value_eur as number | null) ?? null,
      disposalValueEur: (r.disposal_value_eur as number | null) ?? null,
      realizedPnlEur: (r.realized_pnl_eur as number | null) ?? null,
      dex: (r.dex as string | null) ?? null,
      route: (r.route as string[] | null) ?? null,
      liveTradeId: (r.live_trade_id as string | null) ?? null,
      lotDetails: (r.lot_details as TaxRow["lotDetails"]) ?? null,
    }));
    const name = `solarbiter-tax-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}`;
    if (q.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${name}.json"`);
      return reply.send(toJson(tax, { from: from.toISOString(), to: to.toISOString(), mode: "live only (paper trades are never tax events)" }));
    }
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`);
    return reply.send(toCsv(tax));
  });

  f.get("/api/tax/summary", async () => {
    const byYear = await ctx.db.many(
      "SELECT extract(year FROM ts)::int AS year, kind, count(*)::int AS n, COALESCE(sum(realized_pnl_eur), 0) AS pnl_eur, COALESCE(sum(fee_eur), 0) AS fees_eur FROM tax_transactions GROUP BY 1, 2 ORDER BY 1 DESC, 2",
    );
    const unknownBasis = await ctx.db.one("SELECT count(*)::int AS n FROM tax_transactions WHERE kind = 'swap' AND acquisition_value_eur IS NULL");
    return { byYear, unknownCostBasis: unknownBasis, disclaimer: "Keine Steuerberatung." };
  });

  /** The eleven dashboard charts, computed from recorded data only. */
  f.get("/api/charts", async (req) => {
    const { hours } = z.object({ hours: z.coerce.number().min(1).max(24 * 90).default(24) }).parse(req.query);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const bucket = hours <= 6 ? "minute" : hours <= 72 ? "hour" : "day";
    const paperSince = await paperEpochStart(ctx);
    const [equityPaper, equityLive, dailyPnl, oppsOverTime, rejections, spreadHist, predVsReal, slippage, latency, calibration, fees, learningScore] = await Promise.all([
      ctx.db.many("SELECT ts_closed AS ts, sum(realized_net_eur) OVER (ORDER BY ts_closed, id) AS equity FROM paper_trades WHERE success IS NOT NULL AND ts_closed >= $1 ORDER BY ts_closed", [paperSince]),
      ctx.db.many("SELECT COALESCE(ts_confirmed, ts_detected) AS ts, sum(realized_net_eur) OVER (ORDER BY COALESCE(ts_confirmed, ts_detected), id) AS equity FROM live_trades WHERE status IN ('CONFIRMED','FAILED') ORDER BY 1"),
      ctx.db.many(
        `SELECT day, sum(paper) AS paper, sum(live) AS live FROM (
           SELECT date_trunc('day', ts_closed) AS day, realized_net_eur AS paper, 0::float AS live FROM paper_trades WHERE success IS NOT NULL
           UNION ALL SELECT date_trunc('day', COALESCE(ts_confirmed, ts_detected)), 0, realized_net_eur FROM live_trades WHERE status IN ('CONFIRMED','FAILED')) x
         GROUP BY day ORDER BY day`,
      ),
      ctx.db.many(`SELECT date_trunc('${bucket}', ts) AS t, status, count(*)::int AS n FROM opportunities WHERE ts >= $1 GROUP BY 1, 2 ORDER BY 1`, [since]),
      ctx.db.many(
        `SELECT reason, sum(n)::int AS n FROM (
           SELECT rejection_reason AS reason, count(*) AS n FROM opportunities WHERE ts >= $1 AND rejection_reason IS NOT NULL GROUP BY 1
           UNION ALL SELECT reason, sum(count) FROM no_trade_stats WHERE bucket >= $1 GROUP BY 1) x GROUP BY reason ORDER BY 2 DESC`,
        [since],
      ),
      ctx.db.many("SELECT width_bucket(gross_profit_percent * 100, -100, 100, 40) AS b, count(*)::int AS n FROM opportunities WHERE ts >= $1 AND input_amount > 0 GROUP BY 1 ORDER BY 1", [since]),
      ctx.db.many("SELECT predicted_net::float8 / 1e9 * sol_eur AS predicted_eur, realized_net_eur AS realized_eur, success FROM paper_trades WHERE success IS NOT NULL AND ts_closed >= $1 ORDER BY ts_closed DESC LIMIT 500", [since]),
      ctx.db.many(
        "SELECT ts_closed AS ts, (learning->>'predictedSlippageBps')::float8 AS predicted, (learning->>'realizedSlippageBps')::float8 AS realized FROM paper_trades WHERE learning IS NOT NULL AND learning->>'realizedSlippageBps' IS NOT NULL AND ts_closed >= $1 ORDER BY ts_closed",
        [since],
      ),
      ctx.db.many("SELECT width_bucket((learning->>'latencyMs')::float8, 0, 5000, 25) AS b, count(*)::int AS n FROM paper_trades WHERE learning IS NOT NULL AND ts_closed >= $1 GROUP BY 1 ORDER BY 1", [since]),
      ctx.db.many(
        "SELECT width_bucket((learning->>'predictedP')::float8, 0, 1, 10) AS b, avg((learning->>'predictedP')::float8) AS predicted, avg(CASE WHEN success THEN 1 ELSE 0 END) AS realized, count(*)::int AS n FROM paper_trades WHERE learning IS NOT NULL GROUP BY 1 ORDER BY 1",
      ),
      ctx.db.many("SELECT mode, kind, sum(amount_lamports)::text AS lamports, COALESCE(sum(eur), 0) AS eur FROM fees WHERE ts >= $1 GROUP BY 1, 2 ORDER BY 1, 2", [since]),
      ctx.db.many("SELECT ts, (value->>'score')::int AS score, value->>'status' AS status FROM learning_metrics WHERE kind = 'score' ORDER BY ts DESC LIMIT 500"),
    ]);
    return { hours, bucket, equityPaper, equityLive, dailyPnl, oppsOverTime, rejections, spreadHist, predVsReal, slippage, latency, calibration, fees, learningScore: learningScore.reverse() };
  });
}
