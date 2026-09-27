import pino from "pino";
import { describe, expect, it } from "vitest";
import { PoolStateService, DexRegistry } from "@solarbiter/dex";
import { accountBuffers, fixtureRpc, loadPoolFixtures } from "@solarbiter/dex/testing";
import { JupiterClient } from "@solarbiter/jupiter";
import { SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import { RaydiumAdapter } from "./adapter.js";

const log = pino({ level: "silent" });
const fx = loadPoolFixtures();
const all = Object.values(fx.accounts);
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const jupiter = new JupiterClient({ baseUrl: "https://x.test", rps: 1, log });

const apiPool = (id: string, programId: string, mintA: string, decA: number, mintB: string, decB: number, feeRate: number, tvl: number, config?: { id: string; tradeFeeRate: number }) => ({
  type: "x",
  programId,
  id,
  mintA: { address: mintA, decimals: decA, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
  mintB: { address: mintB, decimals: decB, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
  feeRate,
  tvl,
  ...(config ? { config } : {}),
});

function api(pools: unknown[]) {
  return (async () => new Response(JSON.stringify({ id: "x", success: true, data: { count: pools.length, data: pools, hasNextPage: false } }), { status: 200 })) as unknown as typeof fetch;
}

describe("RaydiumAdapter", () => {
  it("discovers pools via the API and verifies them on-chain", async () => {
    const pools = [
      apiPool(fx.accounts.raydium_v4_sol_usdc!.address, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", SOL_MINT, 9, USDC_MINT, 6, 0.0025, 5_000_000),
      apiPool(fx.accounts.raydium_clmm_sol_usdc!.address, "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", SOL_MINT, 9, USDC_MINT, 6, 0.0004, 3_000_000, { id: "cfg", tradeFeeRate: 400 }),
      // claims to be a CLMM pool but the account is owned by another program → dropped
      apiPool(fx.accounts.orca_whirlpool_sol_usdc!.address, "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", SOL_MINT, 9, USDC_MINT, 6, 0.0004, 2_000_000),
      // below the TVL floor → dropped
      apiPool("11111111111111111111111111111112", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", SOL_MINT, 9, USDC_MINT, 6, 0.0025, 10),
    ];
    const a = new RaydiumAdapter(jupiter, fixtureRpc(all), log, { fetchImpl: api(pools) });
    const found = await a.discoverPools(SOL_MINT, USDC_MINT, { minTvlUsd: 50_000, limit: 5 });
    expect(found.map((p) => p.kind)).toEqual(["raydium_amm_v4", "raydium_clmm"]);
    const v4 = found[0]!;
    expect(v4).toMatchObject({ mintA: SOL_MINT, mintB: USDC_MINT, decimalsA: 9, decimalsB: 6, vaultA: fx.accounts.raydium_v4_sol_usdc_base_vault!.address, label: "Raydium" });
    expect(v4.feeRate).toBeCloseTo(0.0025, 8);
    expect(found[1]!.feeRate).toBeCloseTo(0.0004, 8);
    expect(a.stateAccounts(v4)).toHaveLength(3);
  });

  it("decodes v4, CLMM and CPMM state into consistent marginal prices", async () => {
    const a = new RaydiumAdapter(jupiter, fixtureRpc(all), log, {
      fetchImpl: api([
        apiPool(fx.accounts.raydium_v4_sol_usdc!.address, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", SOL_MINT, 9, USDC_MINT, 6, 0.0025, 5_000_000),
        apiPool(fx.accounts.raydium_clmm_sol_usdc!.address, "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", SOL_MINT, 9, USDC_MINT, 6, 0.0004, 3_000_000),
        apiPool(fx.accounts.raydium_cpmm_jup_sol!.address, "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", JUP, 6, SOL_MINT, 9, 0.0025, 1_000_000),
      ]),
    });
    const pools = await a.discoverPools(SOL_MINT, USDC_MINT, { minTvlUsd: 0, limit: 5 });
    expect(pools).toHaveLength(3);
    const reg = new DexRegistry().register(a);
    const svc = new PoolStateService(fixtureRpc(all, fx.slot), reg, log, () => 1_000);
    svc.setPools(pools);
    const states = await svc.poll();
    expect(states).toHaveLength(3);
    const [v4, clmm, cpmm] = states;
    expect(v4!.active).toBe(true);
    expect(v4!.reserveA).toBeGreaterThan(1000);
    expect(Math.abs(clmm!.priceAInB / v4!.priceAInB - 1)).toBeLessThan(0.005);
    expect(cpmm!.feeRate).toBeCloseTo(0.0025, 8);
    expect(cpmm!.priceAInB).toBeGreaterThan(0);
    expect(svc.lastSlot).toBe(fx.slot);
    expect(a.getLiquidity(pools[1]!, clmm!).depth1pctA).toBeGreaterThan(0);
    expect(a.getLiquidity(pools[0]!, v4!).depth1pctA).toBeCloseTo(v4!.reserveA! * 0.005, 6);
  });

  it("marks a pool inactive when its vaults are missing from the batch", () => {
    const a = new RaydiumAdapter(jupiter, fixtureRpc(all), log);
    const acc = accountBuffers([fx.accounts.raydium_v4_sol_usdc!]);
    const pool = { address: fx.accounts.raydium_v4_sol_usdc!.address, dex: "raydium" as const, kind: "raydium_amm_v4" as const, programId: "", label: "Raydium", mintA: SOL_MINT, mintB: USDC_MINT, decimalsA: 9, decimalsB: 6, vaultA: "a", vaultB: "b", feeRate: 0.0025, tvlUsd: 0, extra: {} };
    expect(a.decodeState(pool, acc, 1, 1)).toBeNull();
  });
});
