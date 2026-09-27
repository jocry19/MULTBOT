import { createHash } from "node:crypto";

/** Jupiter Aggregator v6 program. */
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/**
 * Exact-in route instructions (instructionVersion V1). They end with a fixed tail:
 *   route / shared_accounts_route:
 *     in_amount u64 | quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u8
 *   *_with_token_ledger (input = token balance increase since set_token_ledger):
 *     quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u8
 * The program rejects the swap when the output is below quoted_out × (10000 − slippage_bps) / 10000,
 * which is what makes a two-leg arbitrage revert instead of losing money.
 */
const EXACT_IN_ROUTES: Record<string, { name: string; ledger: boolean }> = {
  [anchorDiscriminator("route").toString("hex")]: { name: "route", ledger: false },
  [anchorDiscriminator("shared_accounts_route").toString("hex")]: { name: "shared_accounts_route", ledger: false },
  [anchorDiscriminator("route_with_token_ledger").toString("hex")]: { name: "route_with_token_ledger", ledger: true },
  [anchorDiscriminator("shared_accounts_route_with_token_ledger").toString("hex")]: { name: "shared_accounts_route_with_token_ledger", ledger: true },
};

/** set_token_ledger: records the token account balance the ledger route will measure against. */
export const SET_TOKEN_LEDGER_DISCRIMINATOR = anchorDiscriminator("set_token_ledger").toString("hex");

export interface DecodedRouteArgs {
  instruction: string;
  /** Uses the token ledger: the input is whatever the account received since set_token_ledger. */
  tokenLedger: boolean;
  /** Fixed input (null for token-ledger routes). */
  inAmount: bigint | null;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
}

/** Decode the amount/slippage arguments of a Jupiter exact-in route instruction; null if unknown. */
export function decodeRouteArgs(dataBase64: string): DecodedRouteArgs | null {
  const d = Buffer.from(dataBase64, "base64");
  if (d.length < 8 + 4 + 11) return null;
  const kind = EXACT_IN_ROUTES[d.subarray(0, 8).toString("hex")];
  if (!kind) return null;
  if (kind.ledger) {
    const t = d.length - 11;
    return { instruction: kind.name, tokenLedger: true, inAmount: null, quotedOutAmount: d.readBigUInt64LE(t), slippageBps: d.readUInt16LE(t + 8), platformFeeBps: d.readUInt8(t + 10) };
  }
  if (d.length < 8 + 4 + 19) return null;
  const t = d.length - 19;
  return {
    instruction: kind.name,
    tokenLedger: false,
    inAmount: d.readBigUInt64LE(t),
    quotedOutAmount: d.readBigUInt64LE(t + 8),
    slippageBps: d.readUInt16LE(t + 16),
    platformFeeBps: d.readUInt8(t + 18),
  };
}

// Slippage math lives in @solarbiter/shared (used by paper and live alike).
export { maxSlippageForMinOut, minOutForSlippage } from "@solarbiter/shared";
