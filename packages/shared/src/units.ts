export const LAMPORTS_PER_SOL = 1_000_000_000;

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function solToLamports(sol: number): number {
  if (!Number.isFinite(sol)) throw new Error(`invalid SOL amount: ${sol}`);
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** Solana base58 address sanity check (does not check on-curve). */
export function looksLikeSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
