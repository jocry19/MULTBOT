import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { BusEvents } from "../../app/busEvents.js";
import type { MarketEvent, MarketTrade, TokenCreated } from "../../domain/market.js";
import { WSOL_MINT } from "../pumpfun/constants.js";
import type { GapRecord } from "./pumpStream.js";

const TRADE_COLUMNS = [
  "signature",
  "event_index",
  "slot",
  "ts",
  "available_at",
  "mint",
  "venue",
  "pool",
  "trader",
  "is_buy",
  "sol_amount",
  "token_amount",
  "fee_lamports",
  "fee_bps",
  "price_sol",
  "market_cap_sol",
  "virtual_sol_reserves",
  "virtual_token_reserves",
  "real_sol_reserves",
  "real_token_reserves",
  "ix_name",
  "source",
];

export function tradeRow(t: MarketTrade): unknown[] {
  return [
    t.signature,
    t.eventIndex,
    t.slot,
    new Date(t.ts),
    new Date(t.availableAt),
    t.mint,
    t.venue,
    t.pool,
    t.trader,
    t.isBuy,
    Number(t.solAmount),
    t.tokenAmount.toString(),
    Number(t.feeLamports),
    t.feeBps,
    t.priceSol,
    t.marketCapSol,
    t.virtualSolReserves === null ? null : Number(t.virtualSolReserves),
    t.virtualTokenReserves?.toString() ?? null,
    t.realSolReserves === null ? null : Number(t.realSolReserves),
    t.realTokenReserves?.toString() ?? null,
    t.ixName,
    t.source,
  ];
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Persists raw market data. Writes are batched; on DB failure the buffer is kept and retried
 * (bounded — on overflow the oldest data is dropped and recorded as a data gap).
 */
export class DataCollector extends BaseModule {
  private trades: MarketTrade[] = [];
  private creates: TokenCreated[] = [];
  private lifecycle: MarketEvent[] = [];
  private readonly knownPartitions = new Set<string>();
  private readonly knownMints = new Set<string>();
  private gaps: GapRecord[] = [];
  written = 0;
  dropped = 0;

  constructor(
    private readonly db: Database,
    bus: TypedBus<BusEvents>,
    log: Logger,
    private readonly takeGaps: () => GapRecord[] = () => [],
    private readonly maxBuffered = 200_000,
  ) {
    super("collector", log);
    bus.on("market.events", (events) => this.accept(events));
    this.every("flush", 500, () => this.flush());
  }

  accept(events: MarketEvent[]): void {
    for (const e of events) {
      if (e.kind === "trade") this.trades.push(e.data);
      else if (e.kind === "create") this.creates.push(e.data);
      else if (e.kind !== "liquidity") this.lifecycle.push(e);
    }
    if (this.trades.length > this.maxBuffered) {
      const drop = this.trades.length - this.maxBuffered;
      const lost = this.trades.splice(0, drop);
      this.dropped += drop;
      const first = lost[0];
      const last = lost[lost.length - 1];
      if (first && last) this.gaps.push({ start: first.ts, end: last.ts, reason: "collector buffer overflow (database unavailable)" });
    }
  }

  get buffered(): number {
    return this.trades.length + this.creates.length + this.lifecycle.length;
  }

  override healthDetail(): string {
    return `written=${this.written} buffered=${this.buffered} dropped=${this.dropped}`;
  }

  async ensurePartition(table: string, ts: number): Promise<void> {
    const day = utcDay(ts);
    const key = `${table}:${day}`;
    if (this.knownPartitions.has(key)) return;
    await this.db.query("SELECT ensure_daily_partition($1, $2::date)", [table, day]);
    this.knownPartitions.add(key);
  }

  async flush(): Promise<void> {
    const creates = this.creates.splice(0);
    const trades = this.trades.splice(0);
    const lifecycle = this.lifecycle.splice(0);
    this.gaps.push(...this.takeGaps());
    try {
      if (creates.length > 0) await this.writeCreates(creates);
      if (trades.length > 0) await this.writeTrades(trades);
      if (lifecycle.length > 0) await this.writeLifecycle(lifecycle);
      if (this.gaps.length > 0) {
        const gaps = this.gaps.splice(0);
        await this.db.insertMany(
          "data_gaps",
          ["source", "gap_start", "gap_end", "reason"],
          gaps.map((g) => ["ws:pump", new Date(g.start), new Date(g.end), g.reason]),
        );
      }
    } catch (err) {
      // put everything back (front of the queues) and let the periodic task back off
      this.creates.unshift(...creates);
      this.trades.unshift(...trades);
      this.lifecycle.unshift(...lifecycle);
      throw err;
    }
  }

  private async writeCreates(creates: TokenCreated[]): Promise<void> {
    await this.db.insertMany(
      "tokens",
      [
        "mint",
        "name",
        "symbol",
        "uri",
        "decimals",
        "token_program",
        "creator",
        "bonding_curve",
        "quote_mint",
        "is_mayhem_mode",
        "is_cashback",
        "total_supply",
        "created_at",
        "created_slot",
        "create_signature",
        "available_at",
        "source",
      ],
      creates.map((c) => [
        c.mint,
        c.name.slice(0, 200),
        c.symbol.slice(0, 50),
        c.uri.slice(0, 500),
        6,
        c.tokenProgram,
        c.creator,
        c.bondingCurve,
        c.quoteMint,
        c.isMayhemMode,
        c.isCashback,
        c.tokenTotalSupply.toString(),
        new Date(c.ts),
        c.slot,
        c.signature,
        new Date(c.availableAt),
        c.source,
      ]),
      `ON CONFLICT (mint) DO UPDATE SET
         name = COALESCE(tokens.name, EXCLUDED.name), symbol = COALESCE(tokens.symbol, EXCLUDED.symbol),
         uri = COALESCE(tokens.uri, EXCLUDED.uri), creator = COALESCE(tokens.creator, EXCLUDED.creator),
         bonding_curve = COALESCE(tokens.bonding_curve, EXCLUDED.bonding_curve),
         created_at = COALESCE(tokens.created_at, EXCLUDED.created_at), created_slot = COALESCE(tokens.created_slot, EXCLUDED.created_slot),
         create_signature = COALESCE(tokens.create_signature, EXCLUDED.create_signature),
         is_mayhem_mode = tokens.is_mayhem_mode OR EXCLUDED.is_mayhem_mode, token_program = COALESCE(tokens.token_program, EXCLUDED.token_program)`,
    );
    for (const c of creates) this.knownMints.add(c.mint);
  }

  private async writeTrades(trades: MarketTrade[]): Promise<void> {
    // tokens first seen through a trade (created before we started listening)
    const unknown = new Map<string, MarketTrade>();
    for (const t of trades) if (!this.knownMints.has(t.mint) && !unknown.has(t.mint)) unknown.set(t.mint, t);
    if (unknown.size > 0) {
      await this.db.insertMany(
        "tokens",
        ["mint", "decimals", "available_at", "source", "amm_pool", "amm_quote_mint", "total_supply"],
        // AMM trades only pass normalisation for verified SOL-quoted pools
        [...unknown.values()].map((t) => [t.mint, t.tokenDecimals, new Date(t.availableAt), "discovered", t.pool, t.pool ? WSOL_MINT : null, t.tokenSupply?.toString() ?? null]),
        "ON CONFLICT (mint) DO NOTHING",
      );
      for (const m of unknown.keys()) this.knownMints.add(m);
    }
    const days = new Set(trades.map((t) => utcDay(t.ts)));
    for (const d of days) await this.ensurePartition("market_trades", Date.parse(`${d}T00:00:00Z`));
    await this.db.insertMany("market_trades", TRADE_COLUMNS, trades.map(tradeRow), "ON CONFLICT DO NOTHING");
    this.written += trades.length;
  }

  private async writeLifecycle(events: MarketEvent[]): Promise<void> {
    for (const e of events) {
      if (e.kind === "complete") {
        await this.db.query("UPDATE tokens SET complete_at = COALESCE(complete_at, $2) WHERE mint = $1", [e.data.mint, new Date(e.data.ts)]);
      } else if (e.kind === "migrate") {
        await this.db.query(
          `INSERT INTO tokens (mint, available_at, source, migrated_at, amm_pool, complete_at) VALUES ($1, $2, 'discovered', $3, $4, $3)
           ON CONFLICT (mint) DO UPDATE SET migrated_at = COALESCE(tokens.migrated_at, EXCLUDED.migrated_at), amm_pool = EXCLUDED.amm_pool,
             amm_quote_mint = CASE WHEN tokens.amm_pool IS DISTINCT FROM EXCLUDED.amm_pool THEN NULL ELSE tokens.amm_quote_mint END,
             complete_at = COALESCE(tokens.complete_at, EXCLUDED.complete_at)`,
          [e.data.mint, new Date(e.data.availableAt), new Date(e.data.ts), e.data.pool],
        );
        this.knownMints.add(e.data.mint);
      } else if (e.kind === "pool" && e.data.quoteMint === WSOL_MINT) {
        await this.db.query(
          `INSERT INTO tokens (mint, available_at, source, amm_pool, amm_quote_mint, decimals) VALUES ($1, $2, 'discovered', $3, $5, $4)
           ON CONFLICT (mint) DO UPDATE SET amm_pool = COALESCE(tokens.amm_pool, EXCLUDED.amm_pool),
             amm_quote_mint = CASE WHEN tokens.amm_pool IS NULL OR tokens.amm_pool = EXCLUDED.amm_pool THEN EXCLUDED.amm_quote_mint ELSE tokens.amm_quote_mint END`,
          [e.data.baseMint, new Date(e.data.availableAt), e.data.pool, e.data.baseDecimals, WSOL_MINT],
        );
        this.knownMints.add(e.data.baseMint);
      } else if (e.kind === "pool" && e.data.pool) {
        // non-SOL pool (e.g. USDC-quoted): remember the quote so it is never read as SOL; no new token rows
        await this.db.query(
          "UPDATE tokens SET amm_pool = COALESCE(amm_pool, $2), amm_quote_mint = $3 WHERE mint = $1 AND (amm_pool IS NULL OR amm_pool = $2)",
          [e.data.baseMint, e.data.pool, e.data.quoteMint],
        );
      }
    }
  }
}
