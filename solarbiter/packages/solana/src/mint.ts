import bs58 from "bs58";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export interface MintInfo {
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
}

/** SPL mint layout (first 82 bytes; identical for Token and Token-2022 base mint). */
export function decodeMint(data: Buffer): MintInfo {
  if (data.length < 82) throw new Error(`mint account too short (${data.length} bytes)`);
  const hasMintAuth = data.readUInt32LE(0) === 1;
  const hasFreeze = data.readUInt32LE(46) === 1;
  return {
    mintAuthority: hasMintAuth ? bs58.encode(data.subarray(4, 36)) : null,
    supply: data.readBigUInt64LE(36),
    decimals: data[44] as number,
    isInitialized: data[45] === 1,
    freezeAuthority: hasFreeze ? bs58.encode(data.subarray(50, 82)) : null,
  };
}

/** SPL token account layout: mint (0), owner (32), amount u64 (64). */
export function decodeTokenAccount(data: Buffer): { mint: string; owner: string; amount: bigint } {
  if (data.length < 72) throw new Error("token account too short");
  return { mint: bs58.encode(data.subarray(0, 32)), owner: bs58.encode(data.subarray(32, 64)), amount: data.readBigUInt64LE(64) };
}

export interface TokenSafetyInput {
  mint: string;
  owner: string | null;
  info: MintInfo | null;
  allowlisted: boolean;
  denylisted: boolean;
}

/**
 * Conservative token policy for arbitrage:
 *   - denylisted → rejected
 *   - must be an initialised SPL mint
 *   - Token-2022 (possible transfer fees / hooks / permanent delegate) → only if allowlisted
 *   - freeze authority present (tokens can be frozen mid-trade) → only if allowlisted
 *   - mint authority present is recorded as a risk indicator (supply can be inflated)
 */
export function tokenSafety(t: TokenSafetyInput): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (t.denylisted) reasons.push("token is on the deny list");
  if (!t.owner || !t.info) {
    reasons.push("mint account not found");
    return { safe: false, reasons };
  }
  if (t.owner !== TOKEN_PROGRAM_ID && t.owner !== TOKEN_2022_PROGRAM_ID) reasons.push(`not an SPL mint (owner ${t.owner})`);
  if (!t.info.isInitialized) reasons.push("mint not initialised");
  if (t.owner === TOKEN_2022_PROGRAM_ID && !t.allowlisted) reasons.push("Token-2022 mint (extensions not verified) — allowlist required");
  if (t.info.freezeAuthority && !t.allowlisted) reasons.push("freeze authority present — allowlist required");
  const blocking = reasons.length > 0;
  if (t.info.mintAuthority) reasons.push("note: mint authority present");
  return { safe: !blocking, reasons };
}
