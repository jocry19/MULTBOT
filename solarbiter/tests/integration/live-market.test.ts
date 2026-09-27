/**
 * Live mainnet smoke test (network): pool discovery on all three DEXs, on-chain pool state, DEX-restricted
 * firm quotes and swap-instruction verification. Read-only — nothing is signed or sent.
 *
 *   SOLARBITER_LIVE_TESTS=1 pnpm vitest run tests/integration/live-market.test.ts
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import { DexRegistry, PoolStateService } from "@solarbiter/dex";
import { JupiterClient, minOutForSlippage } from "@solarbiter/jupiter";
import { MeteoraAdapter } from "@solarbiter/meteora";
import { OrcaAdapter } from "@solarbiter/orca";
import { RaydiumAdapter } from "@solarbiter/raydium";
import { DEFAULT_TOKENS, SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import { RpcManager, TokenRegistry } from "@solarbiter/solana";

const live = process.env.SOLARBITER_LIVE_TESTS === "1";
const log = pino({ level: process.env.LOG_LEVEL ?? "silent" });
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // any funded system account works for instruction building

describe.skipIf(!live)("live market data (mainnet, read-only)", () => {
  const rpc = new RpcManager([{ name: "public", kind: "generic", httpUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", wsUrl: null, rps: 4 }], log);
  const jupiter = new JupiterClient({ baseUrl: process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag/swap/v1", apiKey: process.env.JUPITER_API_KEY, rps: 0.5, log });
  const registry = new DexRegistry()
    .register(new RaydiumAdapter(jupiter, rpc, log))
    .register(new OrcaAdapter(jupiter, rpc, log))
    .register(new MeteoraAdapter(jupiter, rpc, log));

  it("token registry reads the default universe on-chain", async () => {
    const reg = new TokenRegistry(rpc, log);
    await reg.load(DEFAULT_TOKENS, { allowlist: [], denylist: [] });
    expect(reg.decimals(USDC_MINT)).toBe(6);
    expect(reg.decimals(SOL_MINT)).toBe(9);
    expect(reg.isTradable("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN")).toBe(true);
    expect(reg.safe().length).toBeGreaterThanOrEqual(8);
  });

  it("discovers SOL/USDC pools on every DEX and reads consistent marginal prices", async () => {
    const pools = (
      await Promise.all(registry.all().map((a) => a.discoverPools(SOL_MINT, USDC_MINT, { minTvlUsd: 100_000, limit: 2 })))
    ).flat();
    const dexes = new Set(pools.map((p) => p.dex));
    expect([...dexes].sort()).toEqual(["meteora", "orca", "raydium"]);
    const svc = new PoolStateService(rpc, registry, log);
    svc.setPools(pools);
    const states = await svc.poll();
    expect(states.length).toBe(pools.length);
    const prices = states.filter((s) => s.active).map((s) => (s.mintA === SOL_MINT ? s.priceAInB : 1 / s.priceAInB));
    const mid = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] as number;
    for (const p of prices) expect(Math.abs(p / mid - 1)).toBeLessThan(0.01);
  }, 60_000);

  it("DEX-restricted firm quote + verified swap instructions with an overridden minimum", async () => {
    const q = await registry.require("orca").getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputDecimals: 9,
      outputDecimals: 6,
      amount: 20_000_000n,
      slippageBps: 30,
      onlyDirectRoutes: true,
      forJitoBundle: true,
      priority: "final",
      maxWaitMs: 5_000,
    });
    expect(q.route.every((h) => h.dex === "orca")).toBe(true);
    expect(q.slot).toBeGreaterThan(0);
    const ix = await registry.require("orca").buildSwap({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true, slippageBps: 7, maxWaitMs: 5_000 });
    expect(ix.minOutputAmount).toBe(minOutForSlippage(q.outputAmount, 7));
    expect(ix.lookupTables.length).toBeGreaterThan(0);
  }, 60_000);
});
