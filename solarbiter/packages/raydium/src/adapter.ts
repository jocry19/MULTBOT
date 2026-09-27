import {
  PROGRAMS,
  concentratedDepth1pct,
  constantProductDepth1pct,
  decodeRaydiumAmmV4,
  decodeRaydiumClmm,
  decodeRaydiumCpmm,
  decodeRaydiumCpmmConfig,
  fetchAccounts,
  fetchJson,
  priceFromSqrtX64,
  tokenAccountAmount,
  type Fetch,
  type LiquidityInfo,
} from "@solarbiter/dex";
import { JupiterRoutedAdapter, POOL_KIND_LABEL, VENUE_LABELS, type JupiterClient } from "@solarbiter/jupiter";
import type { PoolInfo, PoolKind, PoolState } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import type { Logger } from "pino";

export const RAYDIUM_API_URL = "https://api-v3.raydium.io";

/** Pool entry of GET /pools/info/mint (fields used here). */
interface RaydiumApiPool {
  type: string;
  programId: string;
  id: string;
  mintA: { address: string; decimals: number; programId: string };
  mintB: { address: string; decimals: number; programId: string };
  feeRate: number;
  tvl: number;
  config?: { id: string; tradeFeeRate: number };
}

const KIND_BY_PROGRAM: Record<string, PoolKind> = {
  [PROGRAMS.raydiumAmmV4]: "raydium_amm_v4",
  [PROGRAMS.raydiumCpmm]: "raydium_cpmm",
  [PROGRAMS.raydiumClmm]: "raydium_clmm",
};

/** AMM v4 statuses that allow swaps: Initialized, SwapOnly, WaitingTrade. */
const V4_SWAP_STATUSES = new Set([1n, 6n, 7n]);

/**
 * Raydium (AMM v4, CPMM, CLMM). Pools are discovered through the Raydium API and verified on-chain;
 * marginal prices come from the pool accounts; executable quotes and swap instructions are routed
 * through Jupiter restricted to Raydium's venues.
 */
export class RaydiumAdapter extends JupiterRoutedAdapter {
  readonly id = "raydium" as const;
  readonly labels = VENUE_LABELS.raydium;
  readonly poolKinds: PoolKind[] = ["raydium_amm_v4", "raydium_cpmm", "raydium_clmm"];

  constructor(
    jupiter: JupiterClient,
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    private readonly opts: { apiUrl?: string; fetchImpl?: Fetch } = {},
  ) {
    super(jupiter);
  }

  async discoverPools(mintA: string, mintB: string, opts: { minTvlUsd: number; limit: number }): Promise<PoolInfo[]> {
    const q = new URLSearchParams({ mint1: mintA, mint2: mintB, poolType: "all", poolSortField: "liquidity", sortType: "desc", pageSize: "20", page: "1" });
    const res = await fetchJson<{ success: boolean; data: { data: RaydiumApiPool[] } }>(`${this.opts.apiUrl ?? RAYDIUM_API_URL}/pools/info/mint?${q.toString()}`, {
      fetchImpl: this.opts.fetchImpl,
    });
    if (!res.success) throw new Error("Raydium API returned success=false");
    const candidates = res.data.data.filter((p) => KIND_BY_PROGRAM[p.programId] && p.tvl >= opts.minTvlUsd).slice(0, opts.limit);
    if (candidates.length === 0) return [];

    const { accounts } = await fetchAccounts(this.rpc, candidates.map((p) => p.id));
    const out: PoolInfo[] = [];
    for (const p of candidates) {
      const kind = KIND_BY_PROGRAM[p.programId] as PoolKind;
      const acc = accounts.get(p.id);
      if (!acc || acc.owner !== p.programId) {
        this.log.warn({ pool: p.id, kind }, "raydium pool not verified on-chain (missing or wrong owner)");
        continue;
      }
      try {
        const info = this.toPoolInfo(kind, p, acc.data);
        if (info) out.push(info);
      } catch (err) {
        this.log.warn({ pool: p.id, kind, err: (err as Error).message }, "raydium pool decode failed");
      }
    }
    return out;
  }

  private toPoolInfo(kind: PoolKind, p: RaydiumApiPool, data: Buffer): PoolInfo | null {
    const base = { address: p.id, dex: this.id, kind, programId: p.programId, label: POOL_KIND_LABEL[kind], tvlUsd: p.tvl };
    const apiMints = new Set([p.mintA.address, p.mintB.address]);
    if (kind === "raydium_amm_v4") {
      const s = decodeRaydiumAmmV4(data);
      if (!apiMints.has(s.baseMint) || !apiMints.has(s.quoteMint)) return null;
      return {
        ...base,
        mintA: s.baseMint,
        mintB: s.quoteMint,
        decimalsA: s.baseDecimals,
        decimalsB: s.quoteDecimals,
        vaultA: s.baseVault,
        vaultB: s.quoteVault,
        feeRate: Number(s.swapFeeNumerator) / Number(s.swapFeeDenominator),
        extra: {},
      };
    }
    if (kind === "raydium_cpmm") {
      const s = decodeRaydiumCpmm(data);
      if (!apiMints.has(s.mint0) || !apiMints.has(s.mint1)) return null;
      return {
        ...base,
        mintA: s.mint0,
        mintB: s.mint1,
        decimalsA: s.decimals0,
        decimalsB: s.decimals1,
        vaultA: s.vault0,
        vaultB: s.vault1,
        feeRate: p.feeRate,
        extra: { ammConfig: s.ammConfig },
      };
    }
    const s = decodeRaydiumClmm(data);
    if (!apiMints.has(s.mint0) || !apiMints.has(s.mint1)) return null;
    return {
      ...base,
      mintA: s.mint0,
      mintB: s.mint1,
      decimalsA: s.decimals0,
      decimalsB: s.decimals1,
      vaultA: s.vault0,
      vaultB: s.vault1,
      feeRate: p.config ? p.config.tradeFeeRate / 1_000_000 : p.feeRate,
      extra: { ammConfig: s.ammConfig },
    };
  }

  stateAccounts(pool: PoolInfo): string[] {
    if (pool.kind === "raydium_amm_v4") return [pool.address, pool.vaultA as string, pool.vaultB as string];
    if (pool.kind === "raydium_cpmm") return [pool.address, pool.vaultA as string, pool.vaultB as string, pool.extra.ammConfig as string];
    return [pool.address];
  }

  decodeState(pool: PoolInfo, accounts: Map<string, Buffer>, slot: number, now: number): PoolState | null {
    const acc = accounts.get(pool.address);
    if (!acc) return null;
    const common = { pool: pool.address, dex: this.id, kind: pool.kind, mintA: pool.mintA, mintB: pool.mintB, slot, fetchedAt: now };
    if (pool.kind === "raydium_amm_v4") {
      const s = decodeRaydiumAmmV4(acc);
      const va = accounts.get(s.baseVault);
      const vb = accounts.get(s.quoteVault);
      if (!va || !vb) return null;
      const ra = tokenAccountAmount(va) - s.baseNeedTakePnl;
      const rb = tokenAccountAmount(vb) - s.quoteNeedTakePnl;
      if (ra <= 0n || rb <= 0n) return { ...common, priceAInB: 0, feeRate: pool.feeRate, reserveA: 0, reserveB: 0, liquidity: null, active: false };
      const reserveA = Number(ra) / 10 ** pool.decimalsA;
      const reserveB = Number(rb) / 10 ** pool.decimalsB;
      const feeRate = Number(s.swapFeeNumerator) / Number(s.swapFeeDenominator);
      return { ...common, priceAInB: reserveB / reserveA, feeRate, reserveA, reserveB, liquidity: null, active: V4_SWAP_STATUSES.has(s.status) };
    }
    if (pool.kind === "raydium_cpmm") {
      const s = decodeRaydiumCpmm(acc);
      const va = accounts.get(s.vault0);
      const vb = accounts.get(s.vault1);
      const cfg = accounts.get(s.ammConfig);
      if (!va || !vb) return null;
      const ra = tokenAccountAmount(va) - s.protocolFees0 - s.fundFees0;
      const rb = tokenAccountAmount(vb) - s.protocolFees1 - s.fundFees1;
      const feeRate = cfg ? decodeRaydiumCpmmConfig(cfg).tradeFeeRate : pool.feeRate;
      if (ra <= 0n || rb <= 0n) return { ...common, priceAInB: 0, feeRate, reserveA: 0, reserveB: 0, liquidity: null, active: false };
      const reserveA = Number(ra) / 10 ** pool.decimalsA;
      const reserveB = Number(rb) / 10 ** pool.decimalsB;
      // status bit 2 set = swap disabled
      return { ...common, priceAInB: reserveB / reserveA, feeRate, reserveA, reserveB, liquidity: null, active: (s.status & 0b100) === 0 };
    }
    const s = decodeRaydiumClmm(acc);
    return {
      ...common,
      priceAInB: priceFromSqrtX64(s.sqrtPriceX64, pool.decimalsA, pool.decimalsB),
      feeRate: pool.feeRate,
      reserveA: null,
      reserveB: null,
      liquidity: s.liquidity.toString(),
      active: s.liquidity > 0n && (s.status & 0b1_0000) === 0,
    };
  }

  override getLiquidity(pool: PoolInfo, state: PoolState | null): LiquidityInfo {
    if (pool.kind !== "raydium_clmm" || !state?.liquidity) {
      return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: state?.reserveA ?? null, reserveB: state?.reserveB ?? null, depth1pctA: constantProductDepth1pct(state?.reserveA ?? null) };
    }
    // sqrt price back from the marginal price (UI units)
    const sqrtX64 = BigInt(Math.floor(Math.sqrt(state.priceAInB / 10 ** (pool.decimalsA - pool.decimalsB)) * 2 ** 64));
    return { pool: pool.address, tvlUsd: pool.tvlUsd, reserveA: null, reserveB: null, depth1pctA: concentratedDepth1pct(BigInt(state.liquidity), sqrtX64, pool.decimalsA) };
  }
}
