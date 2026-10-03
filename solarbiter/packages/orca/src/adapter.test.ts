import pino from "pino";
import { describe, expect, it } from "vitest";
import { accountBuffers, fixtureRpc, loadPoolFixtures } from "@solarbiter/dex/testing";
import { JupiterClient } from "@solarbiter/jupiter";
import { SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import { OrcaAdapter } from "./adapter.js";

const log = pino({ level: "silent" });
const fx = loadPoolFixtures();
const all = Object.values(fx.accounts);
const jupiter = new JupiterClient({ baseUrl: "https://x.test", rps: 1, log });
const WP = fx.accounts.orca_whirlpool_sol_usdc!;

describe("OrcaAdapter", () => {
  it("discovers whirlpools and rejects API data that does not match the account", async () => {
    const acc = accountBuffers([WP]).get(WP.address)!;
    const { decodeWhirlpool } = await import("@solarbiter/dex");
    const s = decodeWhirlpool(acc);
    const good = { address: WP.address, tokenMintA: SOL_MINT, tokenMintB: USDC_MINT, tokenVaultA: s.vaultA, tokenVaultB: s.vaultB, feeRate: 400, tickSpacing: 4, tvlUsdc: "12000000", tokenA: { decimals: 9, programId: "" }, tokenB: { decimals: 6, programId: "" } };
    const wrongVault = { ...good, tokenVaultA: s.vaultB };
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(String(u));
      return new Response(JSON.stringify({ data: [good, wrongVault], meta: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = new OrcaAdapter(jupiter, fixtureRpc(all), log, { fetchImpl: f });
    const pools = await a.discoverPools(SOL_MINT, USDC_MINT, { minTvlUsd: 50_000, limit: 3 });
    expect(new URL(calls[0]!).searchParams.get("tokensBothOf")).toBe(`${SOL_MINT},${USDC_MINT}`);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ kind: "orca_whirlpool", label: "Whirlpool", decimalsA: 9, decimalsB: 6 });
    expect(pools[0]!.feeRate).toBeCloseTo(0.0004, 8);

    const st = a.decodeState(pools[0]!, accountBuffers(all), fx.slot, 5);
    expect(st!.priceAInB).toBeGreaterThan(50);
    expect(st!.active).toBe(true);
    expect(a.getLiquidity(pools[0]!, st).depth1pctA).toBeGreaterThan(1);
    expect(a.labels).toEqual(["Whirlpool"]);
  });
});
