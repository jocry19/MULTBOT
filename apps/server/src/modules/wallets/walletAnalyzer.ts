import type { Logger } from "pino";
import type { Clock } from "../../core/clock.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import { emptyTotals, type WalletBook, type WalletTotals } from "./walletBook.js";
import { clusterWallets, type CoTradeObservation } from "./clustering.js";

/**
 * Persists wallet intelligence (additive deltas), hydrates wallets from the DB, and periodically
 * clusters wallets that repeatedly enter the same tokens early and in the same slots.
 */
export class WalletAnalyzer extends BaseModule {
  clustersFound = 0;

  constructor(
    private readonly db: Database,
    private readonly book: WalletBook,
    private readonly clock: Clock,
    log: Logger,
  ) {
    super("wallets", log);
    this.every("flush", 15_000, () => this.flush());
    this.every("hydrate", 5_000, () => this.hydrate());
    this.every("cluster", 30 * 60_000, () => this.cluster());
  }

  protected override async onStart(): Promise<void> {
    // wallets with enough history to carry evidence are always kept in memory
    const rows = await this.db.many<WalletRow>(
      `SELECT * FROM wallets WHERE closed_positions >= 5 ORDER BY closed_positions DESC LIMIT 300000`,
    );
    for (const r of rows) this.book.hydrate(r.address, rowToTotals(r), r.cluster_id);
    const creators = await this.db.many<{ address: string; tokens_created: number; tokens_completed: number; quick_dumps: number; first_created_at: Date | null; last_created_at: Date | null }>(
      "SELECT address, tokens_created, tokens_completed, quick_dumps, first_created_at, last_created_at FROM creators WHERE last_created_at > now() - interval '30 days'",
    );
    for (const c of creators) {
      this.book.hydrateCreator(c.address, {
        tokensCreated: c.tokens_created,
        tokensCompleted: c.tokens_completed,
        quickDumps: c.quick_dumps,
        firstCreatedAt: c.first_created_at?.getTime() ?? 0,
        lastCreatedAt: c.last_created_at?.getTime() ?? 0,
      });
    }
    this.log.info({ wallets: rows.length, creators: creators.length }, "wallet intelligence loaded");
  }

  protected override async onStop(): Promise<void> {
    await this.flush().catch((err) => this.log.error({ err }, "final wallet flush failed"));
  }

  override healthDetail(): string {
    return `wallets=${this.book.walletCount} openPositions=${this.book.openPositionCount} clusters=${this.clustersFound}`;
  }

  async hydrate(): Promise<void> {
    const batch = this.book.takeHydrationBatch(1000);
    if (batch.length === 0) return;
    const rows = await this.db.many<WalletRow>("SELECT * FROM wallets WHERE address = ANY($1)", [batch]);
    for (const r of rows) this.book.hydrate(r.address, rowToTotals(r), r.cluster_id);
  }

  async flush(): Promise<void> {
    const deltas = this.book.takeWalletDeltas();
    if (deltas.length > 0) {
      await this.db.insertMany(
        "wallets",
        [
          "address",
          "first_seen_at",
          "last_seen_at",
          "trade_count",
          "buy_count",
          "sell_count",
          "tokens_traded",
          "volume_sol",
          "realized_pnl_sol",
          "closed_positions",
          "winning_positions",
          "early_entries",
          "tokens_created",
          "sum_return",
          "sum_return_sq",
          "sum_hold_sec",
          "sum_entry_sol",
        ],
        deltas.map(({ address, delta: d }) => [
          address,
          new Date(d.firstSeenAt),
          new Date(d.lastSeenAt),
          d.trades,
          d.buys,
          d.sells,
          d.tokensTraded,
          d.volumeSol,
          d.realizedPnlSol,
          d.closedPositions,
          d.winningPositions,
          d.earlyEntries,
          d.tokensCreated,
          d.sumReturn,
          d.sumReturnSq,
          d.sumHoldSec,
          d.sumEntrySol,
        ]),
        `ON CONFLICT (address) DO UPDATE SET
          first_seen_at = LEAST(wallets.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(wallets.last_seen_at, EXCLUDED.last_seen_at),
          trade_count = wallets.trade_count + EXCLUDED.trade_count,
          buy_count = wallets.buy_count + EXCLUDED.buy_count,
          sell_count = wallets.sell_count + EXCLUDED.sell_count,
          tokens_traded = wallets.tokens_traded + EXCLUDED.tokens_traded,
          volume_sol = wallets.volume_sol + EXCLUDED.volume_sol,
          realized_pnl_sol = wallets.realized_pnl_sol + EXCLUDED.realized_pnl_sol,
          closed_positions = wallets.closed_positions + EXCLUDED.closed_positions,
          winning_positions = wallets.winning_positions + EXCLUDED.winning_positions,
          early_entries = wallets.early_entries + EXCLUDED.early_entries,
          tokens_created = wallets.tokens_created + EXCLUDED.tokens_created,
          sum_return = wallets.sum_return + EXCLUDED.sum_return,
          sum_return_sq = wallets.sum_return_sq + EXCLUDED.sum_return_sq,
          sum_hold_sec = wallets.sum_hold_sec + EXCLUDED.sum_hold_sec,
          sum_entry_sol = wallets.sum_entry_sol + EXCLUDED.sum_entry_sol,
          updated_at = now()`,
      );
    }

    const positions = this.book.takeDirtyPositions();
    const closed = this.book.takeClosedPositions();
    const rows = [
      ...positions.map((p) => [p.address, p.mint, BigInt(Math.round(p.tokensBought * 1e6)).toString(), BigInt(Math.round(p.tokensSold * 1e6)).toString(), p.costSol, p.proceedsSol, p.buys, p.sells, p.firstBuyAt ? new Date(p.firstBuyAt) : null, p.firstBuyAgeSec === null ? null : Math.round(p.firstBuyAgeSec), new Date(p.lastTradeAt), null, null]),
      ...closed.map((p) => [p.address, p.mint, BigInt(Math.round(p.tokensBought * 1e6)).toString(), BigInt(Math.round(p.tokensSold * 1e6)).toString(), p.costSol, p.proceedsSol, p.buys, p.sells, p.firstBuyAt ? new Date(p.firstBuyAt) : null, p.firstBuyAgeSec === null ? null : Math.round(p.firstBuyAgeSec), new Date(p.lastTradeAt), new Date(p.closedAt), p.realizedPnlSol]),
    ];
    // de-duplicate by key (a position can be dirty and closed in the same interval → keep the closed row)
    const byKey = new Map<string, unknown[]>();
    for (const r of rows) byKey.set(`${r[0]}|${r[1]}`, r);
    if (byKey.size > 0) {
      await this.db.insertMany(
        "wallet_positions",
        ["address", "mint", "tokens_bought", "tokens_sold", "cost_sol", "proceeds_sol", "buys", "sells", "first_buy_at", "first_buy_age_sec", "last_trade_at", "closed_at", "realized_pnl_sol"],
        [...byKey.values()],
        `ON CONFLICT (address, mint) DO UPDATE SET tokens_bought = EXCLUDED.tokens_bought, tokens_sold = EXCLUDED.tokens_sold,
          cost_sol = EXCLUDED.cost_sol, proceeds_sol = EXCLUDED.proceeds_sol, buys = EXCLUDED.buys, sells = EXCLUDED.sells,
          first_buy_at = COALESCE(wallet_positions.first_buy_at, EXCLUDED.first_buy_at),
          first_buy_age_sec = COALESCE(wallet_positions.first_buy_age_sec, EXCLUDED.first_buy_age_sec),
          last_trade_at = EXCLUDED.last_trade_at, closed_at = EXCLUDED.closed_at, realized_pnl_sol = EXCLUDED.realized_pnl_sol`,
      );
    }
    // notable wallet events: positions closed by wallets with proven skill
    const notable = closed.filter((p) => (this.book.profile(p.address)?.skill ?? 0) > 0);
    if (notable.length > 0) {
      await this.db.insertMany(
        "wallet_events",
        ["address", "ts", "available_at", "type", "mint", "data"],
        notable.map((p) => [p.address, new Date(p.closedAt), new Date(this.clock.now()), "smart_wallet_exit", p.mint, JSON.stringify({ returnPct: p.returnPct, pnlSol: p.realizedPnlSol })]),
      );
    }

    const creators = this.book.takeDirtyCreators();
    if (creators.length > 0) {
      await this.db.insertMany(
        "creators",
        ["address", "tokens_created", "tokens_completed", "quick_dumps", "first_created_at", "last_created_at"],
        creators.map((c) => [c.address, c.tokensCreated, c.tokensCompleted, c.quickDumps, new Date(c.firstCreatedAt), new Date(c.lastCreatedAt)]),
        `ON CONFLICT (address) DO UPDATE SET tokens_created = GREATEST(creators.tokens_created, EXCLUDED.tokens_created),
          tokens_completed = GREATEST(creators.tokens_completed, EXCLUDED.tokens_completed),
          quick_dumps = GREATEST(creators.quick_dumps, EXCLUDED.quick_dumps),
          first_created_at = LEAST(creators.first_created_at, EXCLUDED.first_created_at),
          last_created_at = GREATEST(creators.last_created_at, EXCLUDED.last_created_at), updated_at = now()`,
      );
    }
  }

  /** Co-trading clusters from early buyers of tokens created in the last 24h. */
  async cluster(): Promise<void> {
    const rows = await this.db.many<{ mint: string; trader: string; slot: number; ts: Date }>(
      `WITH recent AS (
         SELECT mint FROM tokens WHERE created_at > now() - interval '24 hours'
       ), ranked AS (
         SELECT t.mint, t.trader, t.slot, t.ts, row_number() OVER (PARTITION BY t.mint ORDER BY t.ts, t.slot) AS rn
         FROM market_trades t JOIN recent r ON r.mint = t.mint
         WHERE t.is_buy AND t.ts > now() - interval '25 hours'
       )
       SELECT mint, trader, slot, ts FROM ranked WHERE rn <= 30`,
    );
    const obs: CoTradeObservation[] = rows.map((r) => ({ mint: r.mint, wallet: r.trader, slot: r.slot, ts: r.ts.getTime() }));
    const clusters = clusterWallets(obs, { minSharedTokens: 3, maxClusterSize: 200 });
    await this.db.tx(async (c) => {
      await c.query("UPDATE wallet_clusters SET active = false WHERE active");
      await c.query("UPDATE wallets SET cluster_id = NULL WHERE cluster_id IS NOT NULL");
      for (const cl of clusters) {
        const res = await c.query<{ id: number }>(
          "INSERT INTO wallet_clusters (method, size, members, features, stats) VALUES ('early_cobuy', $1, $2, $3, $4) RETURNING id",
          [cl.members.length, cl.members, JSON.stringify({ sharedTokens: cl.sharedTokens, sameSlotRate: cl.sameSlotRate }), JSON.stringify({ edges: cl.edges })],
        );
        const id = res.rows[0]?.id ?? null;
        await c.query("UPDATE wallets SET cluster_id = $1 WHERE address = ANY($2)", [id, cl.members]);
        for (const m of cl.members) this.book.setCluster(m, id);
      }
    });
    this.clustersFound = clusters.length;
    if (clusters.length > 0) this.log.info({ clusters: clusters.length }, "wallet clusters updated");
  }
}

type WalletRow = {
  address: string;
  first_seen_at: Date;
  last_seen_at: Date;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  tokens_traded: number;
  volume_sol: number;
  realized_pnl_sol: number;
  closed_positions: number;
  winning_positions: number;
  early_entries: number;
  tokens_created: number;
  sum_return: number;
  sum_return_sq: number;
  sum_hold_sec: number;
  sum_entry_sol: number;
  cluster_id: number | null;
};

function rowToTotals(r: WalletRow): WalletTotals {
  const t = emptyTotals(r.first_seen_at.getTime());
  return {
    ...t,
    lastSeenAt: r.last_seen_at.getTime(),
    trades: r.trade_count,
    buys: r.buy_count,
    sells: r.sell_count,
    tokensTraded: r.tokens_traded,
    volumeSol: r.volume_sol,
    realizedPnlSol: r.realized_pnl_sol,
    closedPositions: r.closed_positions,
    winningPositions: r.winning_positions,
    earlyEntries: r.early_entries,
    tokensCreated: r.tokens_created,
    sumReturn: r.sum_return,
    sumReturnSq: r.sum_return_sq,
    sumHoldSec: r.sum_hold_sec,
    sumEntrySol: r.sum_entry_sol,
  };
}
