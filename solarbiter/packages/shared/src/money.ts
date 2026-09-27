/**
 * Units. On-chain amounts are integers (bigint "raw" units, lamports for SOL). EUR values are plain
 * numbers and only used for reporting, limits and the tax ledger — never for on-chain math.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Base fee per signature (lamports). */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000;
/** Rent-exempt minimum of an SPL token account (165 bytes). Locked, not spent — refundable on close. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

export function lamportsToSol(l: bigint | number): number {
  return Number(l) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

/** EUR → lamports at a SOL/EUR price. Rounds down (never over-spend). */
export function eurToLamports(eur: number, solEur: number): bigint {
  if (!(solEur > 0)) throw new Error("SOL/EUR price unavailable");
  return BigInt(Math.floor((eur / solEur) * LAMPORTS_PER_SOL));
}

export function lamportsToEur(l: bigint | number, solEur: number): number {
  return (Number(l) / LAMPORTS_PER_SOL) * solEur;
}

export function rawToUi(raw: bigint | number | string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function uiToRaw(ui: number, decimals: number): bigint {
  return BigInt(Math.floor(ui * 10 ** decimals));
}

/** Basis points of `part` relative to `whole` (both in the same unit). */
export function bps(part: number | bigint, whole: number | bigint): number {
  const w = Number(whole);
  return w === 0 ? 0 : (Number(part) / w) * 10_000;
}

/** Apply a basis-point haircut: amount × (1 − bps/10000), rounded down. */
export function applyBpsDown(amount: bigint, bpsValue: number): bigint {
  const b = BigInt(Math.max(0, Math.min(10_000, Math.round(bpsValue))));
  return (amount * (10_000n - b)) / 10_000n;
}

export function maxBigInt(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b > a ? b : a));
}

export function minBigInt(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}
