import pino from "pino";
import { describe, expect, it } from "vitest";
import { decodeDlmm } from "@solarbiter/dex";
import { accountBuffers, fixtureRpc, loadPoolFixtures } from "@solarbiter/dex/testing";
import { JupiterClient } from "@solarbiter/jupiter";
import { SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import { MeteoraAdapter } from "./adapter.js";

const log = pino({ level: "silent" });
const fx = loadPoolFixtures();
const all = Object.values(fx.accounts);
const jupiter = new JupiterClient({ baseUrl: "https://x.test", rps: 1, log });
const LB = fx.accounts.meteora_dlmm_sol_usdc!;

describe("MeteoraAdapter", () => {
  it("keeps only pools of the requested pair that match the on-chain LbPair", async () => {
    const s = decodeDlmm(accountBuffers([LB]).get(LB.address)!);
    const pool = (address: string, x: string, y: string, tvl: number, extra: Record<string, unknown> = {}) => ({
      address,
      token_x: { address: x, decimals: 9 },
      token_y: { address: y, decimals: 6 },
      reserve_x: s.reserveX,
      reserve_y: s.reserveY,
      pool_config: { bin_step: 4, base_fee_pct: 0.04 },
      tvl,
      ...extra,
    });
    const page = { total: 3, pages: 1, current_page: 1, page_size: 50, data: [pool(LB.address, SOL_MINT, USDC_MINT, 4_000_000), pool("So11111111111111111111111111111111111111113", SOL_MINT, "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", 9_000_000), pool(LB.address, SOL_MINT, USDC_MINT, 4_000_000, { is_blacklisted: true })] };
    const f = (async () => new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;
    const a = new MeteoraAdapter(jupiter, fixtureRpc(all), log, { fetchImpl: f });
    const pools = await a.discoverPools(SOL_MINT, USDC_MINT, { minTvlUsd: 50_000, limit: 3 });
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ kind: "meteora_dlmm", mintA: SOL_MINT, mintB: USDC_MINT, label: "Meteora DLMM" });
    expect(pools[0]!.feeRate).toBeCloseTo(0.0004, 8);
    const st = a.decodeState(pools[0]!, accountBuffers(all), fx.slot, 5)!;
    expect(st.active).toBe(true);
    expect(st.priceAInB).toBeGreaterThan(50);
    expect(a.labels).toContain("Meteora DLMM");
  });
});
