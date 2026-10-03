import bs58 from "bs58";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import type { RpcManager } from "../solana/rpcManager.js";
import type { PoolInfo } from "../pumpfun/normalize.js";
import { PUMP_AMM_PROGRAM_ID, WSOL_MINT } from "../pumpfun/constants.js";

/**
 * PumpSwap pool → (base mint, quote mint, decimals) resolution.
 * Sources: CreatePool/migration events, the tokens table (only pools whose quote mint is recorded),
 * and on-demand pool account reads. A pool is never assumed to be SOL-quoted: pools can be quoted
 * in USDC or other tokens, and their amounts must not be read as SOL.
 */

/** Pool account layout: 8 discriminator | u8 bump | u16 index | creator 32 | base_mint 32 | quote_mint 32 | … */
export function parsePoolAccount(pool: string, data: Buffer): { pool: string; baseMint: string; quoteMint: string } | null {
  if (data.length < 107) return null;
  return { pool, baseMint: bs58.encode(data.subarray(43, 75)), quoteMint: bs58.encode(data.subarray(75, 107)) };
}

export class PoolRegistry {
  private readonly pools = new Map<string, PoolInfo>();
  private readonly inflight = new Map<string, Promise<PoolInfo | undefined>>();
  private readonly failed = new Map<string, number>();
  /** Mints found to trade against a non-SOL quote (their historical data was purged). */
  readonly rejectedMints = new Set<string>();

  constructor(
    private readonly rpc: RpcManager | null,
    private readonly db: Database | null,
    private readonly log: Logger,
  ) {}

  get size(): number {
    return this.pools.size;
  }

  lookup = (pool: string): PoolInfo | undefined => this.pools.get(pool);

  add(info: PoolInfo): void {
    this.pools.set(info.pool, info);
  }

  /**
   * Load pools with a recorded quote mint, then verify pools whose quote is unknown against the
   * chain. Unverifiable pools are simply not preloaded; they resolve on demand when trades arrive.
   */
  async loadFromDb(): Promise<void> {
    if (!this.db) return;
    const rows = await this.db.many<{ mint: string; amm_pool: string; amm_quote_mint: string; decimals: number | null }>(
      "SELECT mint, amm_pool, amm_quote_mint, decimals FROM tokens WHERE amm_pool IS NOT NULL AND amm_quote_mint IS NOT NULL",
    );
    for (const r of rows) this.add({ pool: r.amm_pool, baseMint: r.mint, quoteMint: r.amm_quote_mint, baseDecimals: r.decimals ?? 6 });
    this.log.info({ pools: rows.length }, "pool registry loaded");
    await this.verifyUnknown().catch((err) => this.log.warn({ err: (err as Error).message }, "pool quote verification failed; will resolve on demand"));
  }

  /** Read pool accounts whose quote mint is unknown, record it and purge non-SOL market data. */
  async verifyUnknown(limit = 20_000): Promise<{ verified: number; rejected: number }> {
    if (!this.db || !this.rpc) return { verified: 0, rejected: 0 };
    const rows = await this.db.many<{ mint: string; amm_pool: string; decimals: number | null }>(
      "SELECT mint, amm_pool, decimals FROM tokens WHERE amm_pool IS NOT NULL AND amm_quote_mint IS NULL LIMIT $1",
      [limit],
    );
    if (rows.length === 0) return { verified: 0, rejected: 0 };
    let verified = 0;
    let rejected = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const accounts = await this.rpc.getMultipleAccounts(chunk.map((r) => r.amm_pool));
      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j] as (typeof chunk)[number];
        const acct = accounts[j];
        if (!acct || acct.owner !== PUMP_AMM_PROGRAM_ID) continue;
        const parsed = parsePoolAccount(row.amm_pool, Buffer.from(acct.data[0], "base64"));
        if (!parsed || parsed.baseMint !== row.mint) continue;
        await this.record(row.mint, row.amm_pool, parsed.quoteMint, row.decimals ?? 6);
        verified++;
        if (parsed.quoteMint !== WSOL_MINT) rejected++;
      }
    }
    this.log.info({ checked: rows.length, verified, rejected }, "pool quote mints verified");
    return { verified, rejected };
  }

  /** Resolve an unknown pool via its on-chain account (deduplicated, negative-cached for 10 min). */
  resolve(pool: string): Promise<PoolInfo | undefined> {
    const known = this.pools.get(pool);
    if (known) return Promise.resolve(known);
    const failedAt = this.failed.get(pool);
    if (failedAt && Date.now() - failedAt < 600_000) return Promise.resolve(undefined);
    const existing = this.inflight.get(pool);
    if (existing) return existing;
    const p = this.fetch(pool).finally(() => this.inflight.delete(pool));
    this.inflight.set(pool, p);
    return p;
  }

  private async record(mint: string, pool: string, quoteMint: string, baseDecimals: number): Promise<void> {
    this.add({ pool, baseMint: mint, quoteMint, baseDecimals });
    if (!this.db) return;
    await this.db.query("UPDATE tokens SET amm_quote_mint = $3 WHERE mint = $1 AND amm_pool = $2", [mint, pool, quoteMint]);
    if (quoteMint !== WSOL_MINT && !this.rejectedMints.has(mint)) {
      this.rejectedMints.add(mint);
      await this.db.query("SELECT purge_token_market_data($1)", [mint]);
      this.log.info({ mint, pool, quoteMint }, "non-SOL-quoted pool: market data excluded");
    }
  }

  private async fetch(pool: string): Promise<PoolInfo | undefined> {
    if (!this.rpc) return undefined;
    try {
      const acct = await this.rpc.getAccountInfo(pool);
      if (!acct) throw new Error("pool account not found");
      if (acct.owner !== PUMP_AMM_PROGRAM_ID) throw new Error("not a PumpSwap pool account");
      const parsed = parsePoolAccount(pool, Buffer.from(acct.data[0], "base64"));
      if (!parsed) throw new Error("pool account too short");
      let baseDecimals = 6;
      if (parsed.quoteMint === WSOL_MINT && !parsed.baseMint.endsWith("pump")) {
        baseDecimals = (await this.rpc.getTokenSupply(parsed.baseMint)).decimals;
      }
      const info = { pool, baseMint: parsed.baseMint, quoteMint: parsed.quoteMint, baseDecimals };
      this.pools.set(pool, info);
      // persist for known tokens so the next start does not have to look it up again
      if (this.db) {
        const r = await this.db.one<{ mint: string }>("SELECT mint FROM tokens WHERE mint = $1 AND amm_pool = $2 AND amm_quote_mint IS NULL", [parsed.baseMint, pool]);
        if (r) await this.record(parsed.baseMint, pool, parsed.quoteMint, baseDecimals);
      }
      return info;
    } catch (err) {
      this.failed.set(pool, Date.now());
      this.log.debug({ pool, err: (err as Error).message }, "pool resolution failed");
      return undefined;
    }
  }
}
