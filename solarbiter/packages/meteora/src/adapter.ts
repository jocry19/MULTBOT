import { PROGRAMS, decodeDlmm, fetchAccounts, fetchJson, priceFromBin, type Fetch, type LiquidityInfo } from "@solarbiter/dex";
import { JupiterRoutedAdapter, POOL_KIND_LABEL, VENUE_LABELS, type JupiterClient } from "@solarbiter/jupiter";
import type { PoolInfo, PoolKind, PoolState } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import type { Logger } from "pino";

export const METEORA_DLMM_API_URL = "https://dlmm.datapi.meteora.ag";

/** Pool entry of GET /pools (fields used here). */
interface MeteoraApiPool {
  address: string;
  token_x: { address: string; decimals: number };
  token_y: { address: string; decimals: number };
  reserve_x: string;
  reserve_y: string;
  pool_config: { bin_step: number; base_fee_pct: number };
  tvl: number;
  is_blacklisted?: boolean;
}

/**
 * Meteora DLMM. Discovery through the Meteora data API (searched by the token mint, filtered to the
 * pair), verified against the on-chain LbPair; executable quotes through Jupiter restricted to the
 * Meteora venues.
 */
export class MeteoraAdapter extends JupiterRoutedAdapter {
  readonly id = "meteora" as const;
  readonly labels = VENUE_LABELS.meteora;
  readonly poolKinds: PoolKind[] = ["meteora_dlmm"];

  constructor(
    jupiter: JupiterClient,
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    private readonly opts: { apiUrl?: string; fetchImpl?: Fetch } = {},
  ) {
    super(jupiter);
  }

  async discoverPools(mintA: string, mintB: string, opts: { minTvlUsd: number; limit: number }): Promise<PoolInfo[]> {
    const pair = new Set([mintA, mintB]);
    const found: MeteoraApiPool[] = [];
    // The search matches either token; page through the (TVL-ordered) results and keep the pair.
    for (let page = 1; page <= 3 && found.length < opts.limit; page++) {
      const q = new URLSearchParams({ page: String(page), page_size: "50", query: mintA });
      const res = await fetchJson<{ data: MeteoraApiPool[]; pages: number }>(`${this.opts.apiUrl ?? METEORA_DLMM_API_URL}/pools?${q.toString()}`, { fetchImpl: this.opts.fetchImpl });
      for (const p of res.data ?? []) {
        if (p.is_blacklisted) continue;
        if (!pair.has(p.token_x.address) || !pair.has(p.token_y.address) || p.token_x.address === p.token_y.address) continue;
        if (p.tvl < opts.minTvlUsd) continue;
        found.push(p);
      }
      if (page >= (res.pages ?? 1)) break;
    }
    const candidates = found.sort((a, b) => b.tvl - a.tvl).slice(0, opts.limit);
    if (candidates.length === 0) return [];
    const { accounts } = await fetchAccounts(this.rpc, candidates.map((p) => p.address));
    const out: PoolInfo[] = [];
    for (const p of candidates) {
      const acc = accounts.get(p.address);
      if (!acc || acc.owner !== PROGRAMS.meteoraDlmm) {
        this.log.warn({ pool: p.address }, "DLMM pair not verified on-chain (missing or wrong owner)");
        continue;
      }
      try {
        const s = decodeDlmm(acc.data);
        if (s.mintX !== p.token_x.address || s.mintY !== p.token_y.address || s.reserveX !== p.reserve_x || s.reserveY !== p.reserve_y || s.binStep !== p.pool_config.bin_step) {
          this.log.warn({ pool: p.address }, "DLMM API data does not match the account");
          continue;
        }
        out.push({
          address: p.address,
          dex: this.id,
          kind: "meteora_dlmm",
          programId: PROGRAMS.meteoraDlmm,
          label: POOL_KIND_LABEL.meteora_dlmm,
          mintA: s.mintX,
          mintB: s.mintY,
          decimalsA: p.token_x.decimals,
          decimalsB: p.token_y.decimals,
          vaultA: s.reserveX,
          vaultB: s.reserveY,
          feeRate: s.baseFeeRate,
          tvlUsd: p.tvl,
          extra: { binStep: String(s.binStep) },
        });
      } catch (err) {
        this.log.warn({ pool: p.address, err: (err as Error).message }, "DLMM decode failed");
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
    const s = decodeDlmm(acc);
    return {
      pool: pool.address,
      dex: this.id,
      kind: pool.kind,
      mintA: pool.mintA,
      mintB: pool.mintB,
      slot,
      fetchedAt: now,
      priceAInB: priceFromBin(s.activeId, s.binStep, pool.decimalsA, pool.decimalsB),
      // base fee only; the variable (volatility) fee comes on top and is contained in firm quotes
      feeRate: s.baseFeeRate,
      reserveA: null,
      reserveB: null,
      liquidity: null,
      active: s.status === 0,
    };
  }

  override getLiquidity(pool: PoolInfo): LiquidityInfo {
    return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: null, reserveB: null, depth1pctA: null };
  }
}
