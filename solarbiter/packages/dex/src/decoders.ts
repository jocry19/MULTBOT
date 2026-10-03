import bs58 from "bs58";

/**
 * On-chain pool account decoders. Offsets were verified against mainnet accounts (see
 * __fixtures__/pool-accounts.json and decoders.test.ts): decoded mints/vaults match the DEX APIs and
 * all four pool families yield the same SOL/USDC price to within a few basis points.
 *
 * These decoders only produce MARGINAL prices for screening. Every trading decision is made on firm,
 * executable quotes.
 */

const pk = (d: Buffer, o: number) => bs58.encode(d.subarray(o, o + 32));
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export const PROGRAMS = {
  raydiumAmmV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumCpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  orcaWhirlpool: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
} as const;

/** Raydium AMM v4 (LIQUIDITY_STATE_LAYOUT_V4, 752 bytes). */
export function decodeRaydiumAmmV4(d: Buffer) {
  if (d.length < 752) throw new Error("raydium v4 account too short");
  return {
    status: d.readBigUInt64LE(0),
    baseDecimals: Number(d.readBigUInt64LE(32)),
    quoteDecimals: Number(d.readBigUInt64LE(40)),
    swapFeeNumerator: d.readBigUInt64LE(176),
    swapFeeDenominator: d.readBigUInt64LE(184),
    baseNeedTakePnl: d.readBigUInt64LE(192),
    quoteNeedTakePnl: d.readBigUInt64LE(200),
    baseVault: pk(d, 336),
    quoteVault: pk(d, 368),
    baseMint: pk(d, 400),
    quoteMint: pk(d, 432),
  };
}

/** Raydium CPMM pool state. */
export function decodeRaydiumCpmm(d: Buffer) {
  if (d.length < 373) throw new Error("raydium cpmm account too short");
  return {
    ammConfig: pk(d, 8),
    vault0: pk(d, 72),
    vault1: pk(d, 104),
    mint0: pk(d, 168),
    mint1: pk(d, 200),
    status: d[329] as number,
    decimals0: d[331] as number,
    decimals1: d[332] as number,
    protocolFees0: d.readBigUInt64LE(341),
    protocolFees1: d.readBigUInt64LE(349),
    fundFees0: d.readBigUInt64LE(357),
    fundFees1: d.readBigUInt64LE(365),
  };
}

/** Raydium CPMM amm config: trade_fee_rate in 1e-6 units. */
export function decodeRaydiumCpmmConfig(d: Buffer) {
  if (d.length < 36) throw new Error("raydium cpmm config too short");
  return { tradeFeeRate: Number(d.readBigUInt64LE(12)) / 1_000_000 };
}

/** Raydium CLMM pool state. status bit 4 set = swaps disabled. */
export function decodeRaydiumClmm(d: Buffer) {
  if (d.length < 390) throw new Error("raydium clmm account too short");
  return {
    ammConfig: pk(d, 9),
    mint0: pk(d, 73),
    mint1: pk(d, 105),
    vault0: pk(d, 137),
    vault1: pk(d, 169),
    decimals0: d[233] as number,
    decimals1: d[234] as number,
    tickSpacing: d.readUInt16LE(235),
    liquidity: u128(d, 237),
    sqrtPriceX64: u128(d, 253),
    tickCurrent: d.readInt32LE(269),
    status: d[389] as number,
  };
}

/** Orca Whirlpool. fee_rate is in hundredths of a basis point (1e-6). */
export function decodeWhirlpool(d: Buffer) {
  if (d.length < 245) throw new Error("whirlpool account too short");
  return {
    tickSpacing: d.readUInt16LE(41),
    feeRate: d.readUInt16LE(45) / 1_000_000,
    liquidity: u128(d, 49),
    sqrtPriceX64: u128(d, 65),
    tickCurrent: d.readInt32LE(81),
    mintA: pk(d, 101),
    vaultA: pk(d, 133),
    mintB: pk(d, 181),
    vaultB: pk(d, 213),
  };
}

/** Meteora DLMM LbPair. Base fee = base_factor × bin_step × 10 × 10^power (1e-9 units). */
export function decodeDlmm(d: Buffer) {
  if (d.length < 216) throw new Error("dlmm account too short");
  const baseFactor = d.readUInt16LE(8);
  const basePowerFactor = d[34] as number; // StaticParameters: 8 + (2+2+2+2+4+4+4+4+2)
  const binStep = d.readUInt16LE(80);
  return {
    baseFactor,
    basePowerFactor,
    activeId: d.readInt32LE(76),
    binStep,
    status: d[82] as number,
    mintX: pk(d, 88),
    mintY: pk(d, 120),
    reserveX: pk(d, 152),
    reserveY: pk(d, 184),
    baseFeeRate: (baseFactor * binStep * 10 * 10 ** basePowerFactor) / 1e9,
  };
}

/** Price of token A in token B (UI units) from a Q64.64 sqrt price. */
export function priceFromSqrtX64(sqrtPriceX64: bigint, decimalsA: number, decimalsB: number): number {
  const sqrt = Number(sqrtPriceX64) / 2 ** 64;
  return sqrt * sqrt * 10 ** (decimalsA - decimalsB);
}

/** DLMM price of X in Y (UI units). */
export function priceFromBin(activeId: number, binStep: number, decimalsX: number, decimalsY: number): number {
  return (1 + binStep / 10_000) ** activeId * 10 ** (decimalsX - decimalsY);
}

/** SPL token account amount (offset 64). */
export function tokenAccountAmount(d: Buffer): bigint {
  if (d.length < 72) throw new Error("token account too short");
  return d.readBigUInt64LE(64);
}
