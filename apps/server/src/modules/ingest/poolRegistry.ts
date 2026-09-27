import bs58 from "bs58";
import type { Logger } from "pino";
import type { Database } from "../../db/database.js";
import type { RpcManager } from "../solana/rpcManager.js";
import type { PoolInfo } from "../pumpfun/normalize.js";
import { WSOL_MINT } from "../pumpfun/constants.js";

/**
 * PumpSwap pool → (base mint, quote mint, decimals) resolution.
 * Sources: CreatePool/migration events, the tokens table, and on-demand pool account reads.
 * Non-SOL pools are cached negatively so they are not fetched again.
 */
export class PoolRegistry {
  private readonly pools = new Map<string, PoolInfo>();
  private readonly inflight = new Map<string, Promise<PoolInfo | undefined>>();
  private readonly failed = new Map<string, number>();

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

  async loadFromDb(): Promise<void> {
    if (!this.db) return;
    const rows = await this.db.many<{ mint: string; amm_pool: string; decimals: number | null }>(
      "SELECT mint, amm_pool, decimals FROM tokens WHERE amm_pool IS NOT NULL",
    );
    for (const r of rows) this.add({ pool: r.amm_pool, baseMint: r.mint, quoteMint: WSOL_MINT, baseDecimals: r.decimals ?? 6 });
    this.log.info({ pools: rows.length }, "pool registry loaded");
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

  private async fetch(pool: string): Promise<PoolInfo | undefined> {
    if (!this.rpc) return undefined;
    try {
      const acct = await this.rpc.getAccountInfo(pool);
      if (!acct) throw new Error("pool account not found");
      const data = Buffer.from(acct.data[0], "base64");
      // 8 discriminator | u8 bump | u16 index | creator 32 | base_mint 32 | quote_mint 32 | …
      if (data.length < 107) throw new Error("pool account too short");
      const baseMint = bs58.encode(data.subarray(43, 75));
      const quoteMint = bs58.encode(data.subarray(75, 107));
      let baseDecimals = 6;
      if (quoteMint === WSOL_MINT && !baseMint.endsWith("pump")) {
        baseDecimals = (await this.rpc.getTokenSupply(baseMint)).decimals;
      }
      const info = { pool, baseMint, quoteMint, baseDecimals };
      this.pools.set(pool, info);
      return info;
    } catch (err) {
      this.failed.set(pool, Date.now());
      this.log.debug({ pool, err: (err as Error).message }, "pool resolution failed");
      return undefined;
    }
  }
}
