import type { RpcManager } from "./rpcManager.js";

/**
 * Helius-specific APIs (DAS + priority fee estimation) with standard-RPC fallbacks, so the rest of
 * the system works (degraded) without a Helius key.
 */

export type PriorityLevel = "Min" | "Low" | "Medium" | "High" | "VeryHigh" | "UnsafeMax";

export interface PriorityFeeEstimate {
  /** micro-lamports per compute unit */
  microLamportsPerCu: number;
  source: "helius" | "recent_fees" | "default";
}

export interface AssetInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  decimals: number | null;
  supply: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mutable: boolean | null;
  tokenProgram: string | null;
}

export interface HolderPage {
  holders: { owner: string; amount: string }[];
  total: number;
  complete: boolean;
}

export class HeliusAdapter {
  constructor(private readonly rpc: RpcManager) {}

  private get heliusEndpoint(): string | undefined {
    return this.rpc.hasHelius() ? "helius" : undefined;
  }

  /** Priority fee estimate for a transaction touching `accountKeys`. */
  async getPriorityFee(accountKeys: string[], level: PriorityLevel = "High"): Promise<PriorityFeeEstimate> {
    const endpoint = this.heliusEndpoint;
    if (endpoint) {
      try {
        const r = await this.rpc.call<{ priorityFeeEstimate?: number }>(
          "getPriorityFeeEstimate",
          [{ accountKeys, options: { priorityLevel: level, recommended: level === "Medium" } }],
          { endpoint, attempts: 2 },
        );
        if (typeof r.priorityFeeEstimate === "number") {
          return { microLamportsPerCu: Math.ceil(r.priorityFeeEstimate), source: "helius" };
        }
      } catch {
        // fall through to standard RPC
      }
    }
    try {
      const fees = await this.rpc.call<{ slot: number; prioritizationFee: number }[]>(
        "getRecentPrioritizationFees",
        [accountKeys.slice(0, 128)],
      );
      const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      if (values.length > 0) {
        const q = { Min: 0, Low: 0.25, Medium: 0.5, High: 0.75, VeryHigh: 0.9, UnsafeMax: 1 }[level];
        const idx = Math.min(values.length - 1, Math.floor(q * (values.length - 1)));
        return { microLamportsPerCu: Math.max(1, values[idx] ?? 1), source: "recent_fees" };
      }
    } catch {
      // ignore
    }
    return { microLamportsPerCu: 100_000, source: "default" };
  }

  /** Token metadata via DAS (Helius) or mint account (fallback). */
  async getAsset(mint: string): Promise<AssetInfo | null> {
    const endpoint = this.heliusEndpoint;
    if (endpoint) {
      try {
        const a = await this.rpc.call<DasAsset>("getAsset", [mint], { endpoint, attempts: 2 });
        return {
          mint,
          name: a.content?.metadata?.name ?? null,
          symbol: a.content?.metadata?.symbol ?? null,
          uri: a.content?.json_uri ?? null,
          decimals: a.token_info?.decimals ?? null,
          supply: a.token_info?.supply !== undefined ? String(a.token_info.supply) : null,
          mintAuthority: a.token_info?.mint_authority ?? null,
          freezeAuthority: a.token_info?.freeze_authority ?? null,
          mutable: a.mutable ?? null,
          tokenProgram: a.token_info?.token_program ?? null,
        };
      } catch {
        // fall back
      }
    }
    const info = await this.rpc.call<{ value: { owner: string; data: { parsed?: { info?: MintInfo } } } | null }>(
      "getAccountInfo",
      [mint, { encoding: "jsonParsed" }],
    );
    const parsed = info.value?.data?.parsed?.info;
    if (!info.value || !parsed) return null;
    return {
      mint,
      name: null,
      symbol: null,
      uri: null,
      decimals: parsed.decimals ?? null,
      supply: parsed.supply ?? null,
      mintAuthority: parsed.mintAuthority ?? null,
      freezeAuthority: parsed.freezeAuthority ?? null,
      mutable: null,
      tokenProgram: info.value.owner,
    };
  }

  /**
   * Holder list for a mint. With Helius this pages through all token accounts (bounded by
   * `maxPages`); without Helius only the 20 largest accounts are available.
   */
  async getHolders(mint: string, maxPages = 5): Promise<HolderPage> {
    const endpoint = this.heliusEndpoint;
    if (endpoint) {
      const byOwner = new Map<string, bigint>();
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < maxPages; page++) {
        const r = await this.rpc.call<{ token_accounts: { owner: string; amount: number | string }[]; cursor?: string }>(
          "getTokenAccounts",
          [{ mint, limit: 1000, ...(cursor ? { cursor } : {}) }],
          { endpoint, attempts: 2 },
        );
        for (const ta of r.token_accounts) {
          const amt = BigInt(String(ta.amount));
          if (amt > 0n) byOwner.set(ta.owner, (byOwner.get(ta.owner) ?? 0n) + amt);
        }
        if (!r.cursor || r.token_accounts.length < 1000) {
          complete = true;
          break;
        }
        cursor = r.cursor;
      }
      const holders = [...byOwner.entries()]
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .map(([owner, amount]) => ({ owner, amount: amount.toString() }));
      return { holders, total: holders.length, complete };
    }
    const largest = await this.rpc.getTokenLargestAccounts(mint);
    return {
      holders: largest.filter((l) => l.amount !== "0").map((l) => ({ owner: l.address, amount: l.amount })),
      total: largest.length,
      complete: false,
    };
  }
}

interface MintInfo {
  decimals?: number;
  supply?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

interface DasAsset {
  content?: { json_uri?: string; metadata?: { name?: string; symbol?: string } };
  token_info?: {
    decimals?: number;
    supply?: number | string;
    mint_authority?: string;
    freeze_authority?: string;
    token_program?: string;
  };
  mutable?: boolean;
}
