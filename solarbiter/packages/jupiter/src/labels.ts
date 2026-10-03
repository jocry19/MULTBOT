import type { DexId, PoolKind } from "@solarbiter/shared";

/**
 * Jupiter venue labels (as listed by /program-id-to-label and reported in routePlan[].swapInfo.label)
 * for the DEXs SOLARBITER trades on. The quote API's `dexes` filter takes these labels.
 */
export const VENUE_LABELS: Record<Exclude<DexId, "jupiter">, string[]> = {
  raydium: ["Raydium", "Raydium CP", "Raydium CLMM"],
  orca: ["Whirlpool"],
  meteora: ["Meteora DLMM", "Meteora", "Meteora DAMM v2"],
};

/** Label of the pool family whose on-chain state SOLARBITER decodes. */
export const POOL_KIND_LABEL: Record<PoolKind, string> = {
  raydium_amm_v4: "Raydium",
  raydium_cpmm: "Raydium CP",
  raydium_clmm: "Raydium CLMM",
  orca_whirlpool: "Whirlpool",
  meteora_dlmm: "Meteora DLMM",
};

/** DEX of a venue label; anything outside the three DEXs is attributed to the aggregator. */
export function dexForLabel(label: string): DexId {
  for (const [dex, labels] of Object.entries(VENUE_LABELS) as [DexId, string[]][]) {
    if (labels.includes(label)) return dex;
  }
  return "jupiter";
}
