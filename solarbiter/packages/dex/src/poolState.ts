import type { PoolInfo, PoolState } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import type { Logger } from "pino";
import type { DexRegistry } from "./registry.js";

/**
 * Live pool state: all tracked pools (and their vaults/configs) are read in batched
 * getMultipleAccounts calls — one RPC request covers up to 100 accounts — and decoded into marginal
 * prices with the slot they were read at.
 */
export class PoolStateService {
  private pools: PoolInfo[] = [];
  private readonly states = new Map<string, PoolState>();
  private readonly listeners = new Set<(states: PoolState[]) => void>();
  lastPollAt: number | null = null;
  lastSlot: number | null = null;
  lastError: string | null = null;
  decodeErrors = 0;

  constructor(
    private readonly rpc: RpcManager,
    private readonly registry: DexRegistry,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  setPools(pools: PoolInfo[]): void {
    this.pools = pools;
    const keep = new Set(pools.map((p) => p.address));
    for (const k of this.states.keys()) if (!keep.has(k)) this.states.delete(k);
  }

  get trackedPools(): PoolInfo[] {
    return this.pools;
  }

  onUpdate(fn: (states: PoolState[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(pool: string): PoolState | undefined {
    return this.states.get(pool);
  }

  all(): PoolState[] {
    return [...this.states.values()];
  }

  /** Oldest state age among active pools (for the stale-data breaker). */
  maxAgeMs(): number | null {
    const s = this.all();
    if (s.length === 0) return null;
    const now = this.now();
    return Math.max(...s.map((x) => now - x.fetchedAt));
  }

  async poll(): Promise<PoolState[]> {
    const accountList: string[] = [];
    const owners: { pool: PoolInfo; accounts: string[] }[] = [];
    for (const pool of this.pools) {
      const adapter = this.registry.forKind(pool.kind);
      if (!adapter) continue;
      const accts = adapter.stateAccounts(pool);
      owners.push({ pool, accounts: accts });
      for (const a of accts) if (!accountList.includes(a)) accountList.push(a);
    }
    if (accountList.length === 0) return [];
    let res: { slot: number; accounts: ({ data: [string, string] } | null)[] };
    try {
      res = await this.rpc.getMultipleAccountsWithSlot(accountList);
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
    const byAddress = new Map<string, Buffer>();
    accountList.forEach((a, i) => {
      const acc = res.accounts[i];
      if (acc) byAddress.set(a, Buffer.from(acc.data[0], "base64"));
    });
    const now = this.now();
    const updated: PoolState[] = [];
    for (const { pool } of owners) {
      const adapter = this.registry.forKind(pool.kind);
      if (!adapter) continue;
      try {
        const st = adapter.decodeState(pool, byAddress, res.slot, now);
        if (st) {
          this.states.set(pool.address, st);
          updated.push(st);
        }
      } catch (err) {
        this.decodeErrors++;
        this.log.warn({ pool: pool.address, kind: pool.kind, err: (err as Error).message }, "pool decode failed");
      }
    }
    this.lastPollAt = now;
    this.lastSlot = res.slot;
    this.lastError = null;
    for (const l of this.listeners) l(updated);
    return updated;
  }
}
