import { createHash } from "node:crypto";

/** Jupiter Aggregator v6 program. */
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/**
 * Exact-in route instructions (instructionVersion V1). Both end with the same fixed tail:
 *   in_amount u64 | quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u8
 * The program rejects the swap when the output is below quoted_out × (10000 − slippage_bps) / 10000,
 * which is what makes a two-leg arbitrage revert instead of losing money.
 */
const EXACT_IN_ROUTES: Record<string, string> = {
  [anchorDiscriminator("route").toString("hex")]: "route",
  [anchorDiscriminator("shared_accounts_route").toString("hex")]: "shared_accounts_route",
};

export interface DecodedRouteArgs {
  instruction: string;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
}

/** Decode the amount/slippage arguments of a Jupiter exact-in route instruction; null if unknown. */
export function decodeRouteArgs(dataBase64: string): DecodedRouteArgs | null {
  const d = Buffer.from(dataBase64, "base64");
  if (d.length < 8 + 4 + 19) return null;
  const name = EXACT_IN_ROUTES[d.subarray(0, 8).toString("hex")];
  if (!name) return null;
  const t = d.length - 19;
  return {
    instruction: name,
    inAmount: d.readBigUInt64LE(t),
    quotedOutAmount: d.readBigUInt64LE(t + 8),
    slippageBps: d.readUInt16LE(t + 16),
    platformFeeBps: d.readUInt8(t + 18),
  };
}

/** Minimum output the program enforces (rounded down: never assume more than guaranteed). */
export function minOutForSlippage(quotedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error(`invalid slippageBps ${slippageBps}`);
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Smallest slippage tolerance (bps) whose enforced minimum output still reaches `requiredOut`.
 * Returns null if even 0 bps cannot reach it (the quote itself is below the requirement).
 */
export function maxSlippageForMinOut(quotedOut: bigint, requiredOut: bigint): number | null {
  if (quotedOut < requiredOut || quotedOut <= 0n) return null;
  // largest s with quotedOut × (10000 − s) / 10000 ≥ requiredOut
  let s = Number(((quotedOut - requiredOut) * 10_000n) / quotedOut);
  s = Math.min(10_000, Math.max(0, s));
  while (s > 0 && minOutForSlippage(quotedOut, s) < requiredOut) s--;
  return minOutForSlippage(quotedOut, s) >= requiredOut ? s : null;
}
