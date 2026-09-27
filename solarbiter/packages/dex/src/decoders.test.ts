import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import {
  decodeDlmm,
  decodeRaydiumAmmV4,
  decodeRaydiumClmm,
  decodeRaydiumCpmm,
  decodeRaydiumCpmmConfig,
  decodeWhirlpool,
  priceFromBin,
  priceFromSqrtX64,
  tokenAccountAmount,
} from "./decoders.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, "__fixtures__/pool-accounts.json"), "utf8")) as {
  slot: number;
  accounts: Record<string, { address: string; owner: string; data: string }>;
};
const buf = (k: string) => Buffer.from((fx.accounts[k] as { data: string }).data, "base64");
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

describe("pool decoders (mainnet fixtures, one slot)", () => {
  const v4 = decodeRaydiumAmmV4(buf("raydium_v4_sol_usdc"));
  const baseReserve = tokenAccountAmount(buf("raydium_v4_sol_usdc_base_vault")) - v4.baseNeedTakePnl;
  const quoteReserve = tokenAccountAmount(buf("raydium_v4_sol_usdc_quote_vault")) - v4.quoteNeedTakePnl;
  const v4Price = Number(quoteReserve) / 1e6 / (Number(baseReserve) / 1e9);

  it("Raydium AMM v4: mints, vaults, fee and reserve price", () => {
    expect(v4.baseMint).toBe(SOL_MINT);
    expect(v4.quoteMint).toBe(USDC_MINT);
    expect(v4.baseVault).toBe(fx.accounts.raydium_v4_sol_usdc_base_vault?.address);
    expect(Number(v4.swapFeeNumerator) / Number(v4.swapFeeDenominator)).toBeCloseTo(0.0025, 6);
    expect(v4Price).toBeGreaterThan(50);
    expect(v4Price).toBeLessThan(500);
  });

  it("Orca Whirlpool, Raydium CLMM and Meteora DLMM agree with Raydium v4 within 0.5 %", () => {
    const w = decodeWhirlpool(buf("orca_whirlpool_sol_usdc"));
    expect(w.mintA).toBe(SOL_MINT);
    expect(w.mintB).toBe(USDC_MINT);
    expect(w.feeRate).toBeCloseTo(0.0004, 8);
    const wp = priceFromSqrtX64(w.sqrtPriceX64, 9, 6);

    const c = decodeRaydiumClmm(buf("raydium_clmm_sol_usdc"));
    expect(c.mint0).toBe(SOL_MINT);
    expect(c.mint1).toBe(USDC_MINT);
    const cp = priceFromSqrtX64(c.sqrtPriceX64, c.decimals0, c.decimals1);

    const d = decodeDlmm(buf("meteora_dlmm_sol_usdc"));
    expect(d.mintX).toBe(SOL_MINT);
    expect(d.mintY).toBe(USDC_MINT);
    expect(d.binStep).toBe(4);
    expect(d.baseFeeRate).toBeCloseTo(0.0004, 8); // API: base_fee_pct 0.04
    const dp = priceFromBin(d.activeId, d.binStep, 9, 6);

    for (const p of [wp, cp, dp]) expect(Math.abs(p / v4Price - 1)).toBeLessThan(0.005);
  });

  it("Raydium CPMM: mints, vaults, fee from amm config", () => {
    const p = decodeRaydiumCpmm(buf("raydium_cpmm_jup_sol"));
    expect(p.mint0).toBe(JUP);
    expect(p.mint1).toBe(SOL_MINT);
    expect(p.ammConfig).toBe(fx.accounts.raydium_cpmm_jup_sol_config?.address);
    expect(p.vault0).toBe(fx.accounts.raydium_cpmm_jup_sol_vault0?.address);
    expect(decodeRaydiumCpmmConfig(buf("raydium_cpmm_jup_sol_config")).tradeFeeRate).toBeCloseTo(0.0025, 8);
    const r0 = tokenAccountAmount(buf("raydium_cpmm_jup_sol_vault0")) - p.protocolFees0 - p.fundFees0;
    const r1 = tokenAccountAmount(buf("raydium_cpmm_jup_sol_vault1")) - p.protocolFees1 - p.fundFees1;
    const jupInSol = Number(r1) / 1e9 / (Number(r0) / 1e6);
    expect(jupInSol).toBeGreaterThan(0);
    expect(jupInSol).toBeLessThan(0.1);
  });

  it("rejects truncated accounts", () => {
    expect(() => decodeWhirlpool(Buffer.alloc(10))).toThrow();
    expect(() => decodeRaydiumAmmV4(Buffer.alloc(100))).toThrow();
  });
});
