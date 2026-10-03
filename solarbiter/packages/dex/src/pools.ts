import type { RpcManager } from "@solarbiter/solana";

export interface FetchedAccount {
  owner: string;
  data: Buffer;
}

/** Read accounts (batched getMultipleAccounts) with their owner program — used to verify discovered pools. */
export async function fetchAccounts(rpc: RpcManager, addresses: string[]): Promise<{ slot: number; accounts: Map<string, FetchedAccount> }> {
  const unique = [...new Set(addresses)];
  const accounts = new Map<string, FetchedAccount>();
  if (unique.length === 0) return { slot: 0, accounts };
  const r = await rpc.getMultipleAccountsWithSlot(unique);
  unique.forEach((a, i) => {
    const acc = r.accounts[i];
    if (acc) accounts.set(a, { owner: acc.owner, data: Buffer.from(acc.data[0], "base64") });
  });
  return { slot: r.slot, accounts };
}

/**
 * Rough depth of a concentrated-liquidity pool: amount of token A (UI units) that moves the price ~1 %
 * within the current liquidity range (Δx = L · (1/√P' − 1/√P), ignoring tick boundaries).
 */
export function concentratedDepth1pct(liquidity: bigint, sqrtPriceX64: bigint, decimalsA: number): number | null {
  const sqrtP = Number(sqrtPriceX64) / 2 ** 64;
  if (!(sqrtP > 0) || liquidity <= 0n) return null;
  const dxRaw = (Number(liquidity) / sqrtP) * (1 / Math.sqrt(0.99) - 1);
  return dxRaw / 10 ** decimalsA;
}

/** Constant-product depth: selling ~0.5 % of the reserve moves the price ~1 %. */
export function constantProductDepth1pct(reserveA: number | null): number | null {
  return reserveA !== null && reserveA > 0 ? reserveA * 0.005 : null;
}
