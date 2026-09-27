import { PROGRAMS, concentratedDepth1pct, decodeWhirlpool, fetchAccounts, fetchJson, priceFromSqrtX64, type Fetch, type LiquidityInfo } from "@solarbiter/dex";
import { JupiterRoutedAdapter, POOL_KIND_LABEL, VENUE_LABELS, type JupiterClient } from "@solarbiter/jupiter";
import type { PoolInfo, PoolKind, PoolState } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import type { Logger } from "pino";

export const ORCA_API_URL = "https://api.orca.so/v2/solana";

/** Pool entry of GET /pools (fields used here). feeRate is in hundredths of a basis point. */
interface OrcaApiPool {
  address: string;
  tokenMintA: string;
  tokenMintB: string;
  tokenVaultA: string;
  tokenVaultB: string;
  feeRate: number;
  tickSpacing: number;
  tvlUsdc: string | number | null;
  tokenA?: { decimals: number; programId: string };
  tokenB?: { decimals: number; programId: string };
}

/**
 * Orca Whirlpools. Discovery through the Orca API, verified against the on-chain whirlpool account;
 * executable quotes through Jupiter restricted to the "Whirlpool" venue.
 */
export class OrcaAdapter extends JupiterRoutedAdapter {
  readonly id = "orca" as const;
  readonly labels = VENUE_LABELS.orca;
  readonly poolKinds: PoolKind[] = ["orca_whirlpool"];

  constructor(
    jupiter: JupiterClient,
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    private readonly opts: { apiUrl?: string; fetchImpl?: Fetch } = {},
  ) {
    super(jupiter);
  }

  async discoverPools(mintA: string, mintB: string, opts: { minTvlUsd: number; limit: number }): Promise<PoolInfo[]> {
    const q = new URLSearchParams({ tokensBothOf: `${mintA},${mintB}`, sortBy: "tvl", sortDirection: "desc", size: "20" });
    const res = await fetchJson<{ data: OrcaApiPool[] }>(`${this.opts.apiUrl ?? ORCA_API_URL}/pools?${q.toString()}`, { fetchImpl: this.opts.fetchImpl });
    const candidates = (res.data ?? [])
      .filter((p) => Number(p.tvlUsdc ?? 0) >= opts.minTvlUsd && p.tokenA && p.tokenB)
      .slice(0, opts.limit);
    if (candidates.length === 0) return [];
    const { accounts } = await fetchAccounts(this.rpc, candidates.map((p) => p.address));
    const out: PoolInfo[] = [];
    for (const p of candidates) {
      const acc = accounts.get(p.address);
      if (!acc || acc.owner !== PROGRAMS.orcaWhirlpool) {
        this.log.warn({ pool: p.address }, "whirlpool not verified on-chain (missing or wrong owner)");
        continue;
      }
      try {
        const s = decodeWhirlpool(acc.data);
        if (s.mintA !== p.tokenMintA || s.mintB !== p.tokenMintB || s.vaultA !== p.tokenVaultA || s.vaultB !== p.tokenVaultB) {
          this.log.warn({ pool: p.address }, "whirlpool API data does not match the account");
          continue;
        }
        out.push({
          address: p.address,
          dex: this.id,
          kind: "orca_whirlpool",
          programId: PROGRAMS.orcaWhirlpool,
          label: POOL_KIND_LABEL.orca_whirlpool,
          mintA: s.mintA,
          mintB: s.mintB,
          decimalsA: (p.tokenA as { decimals: number }).decimals,
          decimalsB: (p.tokenB as { decimals: number }).decimals,
          vaultA: s.vaultA,
          vaultB: s.vaultB,
          feeRate: s.feeRate,
          tvlUsd: Number(p.tvlUsdc ?? 0),
          extra: { tickSpacing: String(s.tickSpacing) },
        });
      } catch (err) {
        this.log.warn({ pool: p.address, err: (err as Error).message }, "whirlpool decode failed");
      }
    }
    return out;
  }

  stateAccounts(pool: PoolInfo): string[] {
    return [pool.address];
  }

  decodeState(pool: PoolInfo, accounts: Map<string, Buffer>, slot: number, now: number): PoolState | null {
    const acc = accounts.get(pool.address);
    if (!acc) return null;
    const s = decodeWhirlpool(acc);
    return {
      pool: pool.address,
      dex: this.id,
      kind: pool.kind,
      mintA: pool.mintA,
      mintB: pool.mintB,
      slot,
      fetchedAt: now,
      priceAInB: priceFromSqrtX64(s.sqrtPriceX64, pool.decimalsA, pool.decimalsB),
      // the fee rate can change (adaptive fee tiers): always take it from the account
      feeRate: s.feeRate,
      reserveA: null,
      reserveB: null,
      liquidity: s.liquidity.toString(),
      active: s.liquidity > 0n,
    };
  }

  override getLiquidity(pool: PoolInfo, state: PoolState | null): LiquidityInfo {
    if (!state?.liquidity) return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: null, reserveB: null, depth1pctA: null };
    const sqrtX64 = BigInt(Math.floor(Math.sqrt(state.priceAInB / 10 ** (pool.decimalsA - pool.decimalsB)) * 2 ** 64));
    return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: null, reserveB: null, depth1pctA: concentratedDepth1pct(BigInt(state.liquidity), sqrtX64, pool.decimalsA) };
  }
}
