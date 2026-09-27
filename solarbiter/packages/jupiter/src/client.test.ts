import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "@solarbiter/shared";
import { QuoteBudget } from "@solarbiter/quotes";
import { JupiterClient, QuoteBudgetExhaustedError } from "./client.js";
import { decodeRouteArgs, maxSlippageForMinOut, minOutForSlippage } from "./instruction.js";
import { dexForLabel } from "./labels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(here, "__fixtures__", name), "utf8")) as Record<string, unknown>;
const log = pino({ level: "silent" });
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function fakeFetch(routes: Record<string, (url: URL, body: unknown) => unknown>, calls: { url: URL; body: unknown }[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const handler = routes[key] as (url: URL, body: unknown) => unknown;
    return new Response(JSON.stringify(handler(url, body)), { status: 200 });
  }) as typeof fetch;
}

const baseReq = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inputDecimals: 9,
  outputDecimals: 6,
  amount: 40_000_000n,
  slippageBps: 30,
  onlyDirectRoutes: true,
  priority: "final" as const,
};

describe("Jupiter route instruction decoding (mainnet fixtures)", () => {
  it("decodes route args of a Raydium and a Whirlpool swap", () => {
    const a = decodeRouteArgs((fixture("swapix-sol-usdc-raydium.json").swapInstruction as { data: string }).data);
    expect(a).toMatchObject({ instruction: "route", inAmount: 40_000_000n, quotedOutAmount: 4_861_899n, slippageBps: 30, platformFeeBps: 0 });
    const b = decodeRouteArgs((fixture("swapix-usdc-sol-whirlpool.json").swapInstruction as { data: string }).data);
    expect(b).toMatchObject({ inAmount: 4_800_000n, quotedOutAmount: 39_294_481n, slippageBps: 30 });
    expect(decodeRouteArgs(Buffer.alloc(40).toString("base64"))).toBeNull();
  });

  it("minimum output and the slippage that still guarantees a required output", () => {
    expect(minOutForSlippage(4_861_899n, 30)).toBe(4_847_313n);
    const s = maxSlippageForMinOut(40_100_000n, 40_020_000n);
    expect(s).not.toBeNull();
    expect(minOutForSlippage(40_100_000n, s as number)).toBeGreaterThanOrEqual(40_020_000n);
    expect(minOutForSlippage(40_100_000n, (s as number) + 1)).toBeLessThan(40_020_000n);
    expect(maxSlippageForMinOut(40_000_000n, 40_000_001n)).toBeNull();
    expect(maxSlippageForMinOut(40_000_000n, 40_000_000n)).toBe(0);
  });

  it("maps venue labels to DEXs", () => {
    expect(dexForLabel("Raydium CLMM")).toBe("raydium");
    expect(dexForLabel("Whirlpool")).toBe("orca");
    expect(dexForLabel("Meteora DLMM")).toBe("meteora");
    expect(dexForLabel("Phoenix")).toBe("jupiter");
  });
});

describe("JupiterClient", () => {
  it("requests a DEX-restricted direct quote and maps it", async () => {
    const calls: { url: URL; body: unknown }[] = [];
    let t = 1_000_000;
    const c = new JupiterClient({ baseUrl: "https://lite-api.jup.ag/swap/v1", rps: 10, log, now: () => (t += 5), fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json") }, calls) });
    const q = await c.quote(baseReq, ["Raydium", "Raydium CP", "Raydium CLMM"], "raydium");
    const u = calls[0]?.url as URL;
    expect(u.searchParams.get("dexes")).toBe("Raydium,Raydium CP,Raydium CLMM");
    expect(u.searchParams.get("onlyDirectRoutes")).toBe("true");
    expect(u.searchParams.get("swapMode")).toBe("ExactIn");
    expect(q.kind).toBe("firm");
    expect(q.slot).toBe(451046205);
    expect(q.outputAmount).toBe(4_861_899n);
    expect(q.minOutputAmount).toBe(4_847_313n);
    expect(q.route[0]).toMatchObject({ dex: "raydium", label: "Raydium", pool: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" });
    expect(q.price).toBeCloseTo(121.547, 2);
    expect(q.timestamp).toBeGreaterThan(1_000_000);
  });

  it("uses api.jup.ag with the x-api-key header when a key is configured", async () => {
    const seen: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input), String((init?.headers as Record<string, string>)["x-api-key"]));
      return new Response(JSON.stringify(fixture("quote-sol-usdc-raydium.json")), { status: 200 });
    }) as typeof fetch;
    const c = new JupiterClient({ baseUrl: "https://lite-api.jup.ag/swap/v1", apiKey: "k-123", rps: 10, log, fetchImpl: f });
    await c.quote(baseReq, null, "jupiter");
    expect(seen[0]).toMatch(/^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/);
    expect(seen[1]).toBe("k-123");
  });

  it("rejects routes through venues outside the DEX filter", async () => {
    const c = new JupiterClient({ baseUrl: "https://x.test", rps: 10, log, fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json") }) });
    await expect(c.quote(baseReq, ["Whirlpool"], "orca")).rejects.toThrow(/outside the filter/);
  });

  it("refuses quotes when the request budget is exhausted (priorities respected, 60 s sliding window)", async () => {
    let t = 0;
    const budget = new QuoteBudget(0.5, () => t); // keyless: 30/min, 27 after the safety margin
    const c = new JupiterClient({ baseUrl: "https://x.test", rps: 0.5, log, budget, now: () => t, fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json") }) });
    // bursts inside the window are fine: all legs of a route can be quoted at once
    for (let i = 0; i < 13; i++) await c.quote({ ...baseReq, priority: "ladder" }, null, "jupiter");
    // ladder quotes may only use half of the window
    await expect(c.quote({ ...baseReq, priority: "ladder" }, null, "jupiter")).rejects.toBeInstanceOf(QuoteBudgetExhaustedError);
    // money-protecting checks still get through
    for (let i = 0; i < 14; i++) await c.quote({ ...baseReq, priority: "final" }, null, "jupiter");
    await expect(c.quote({ ...baseReq, priority: "final" }, null, "jupiter")).rejects.toBeInstanceOf(QuoteBudgetExhaustedError);
    expect(budget.usage()).toEqual({ used1m: 27, limit1m: 27 });
    t += 60_001;
    await c.quote({ ...baseReq, priority: "ladder" }, null, "jupiter");
  });

  it("builds swap instructions with an overridden slippage and verifies the encoded minimum", async () => {
    const calls: { url: URL; body: unknown }[] = [];
    const ix = fixture("swapix-sol-usdc-raydium.json");
    const c = new JupiterClient({ baseUrl: "https://x.test", rps: 10, log, fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json"), "/swap-instructions": () => ix }, calls) });
    const q = await c.quote(baseReq, null, "jupiter");
    const built = await c.swapInstructions({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true });
    const body = calls[1]?.body as { quoteResponse: { slippageBps: number; otherAmountThreshold: string }; userPublicKey: string };
    expect(body.userPublicKey).toBe(USER);
    expect(body.quoteResponse.slippageBps).toBe(30);
    expect(body.quoteResponse.otherAmountThreshold).toBe("4847313");
    expect(built.minOutputAmount).toBe(4_847_313n);
    expect(built.setup).toHaveLength(2);
    expect(built.cleanup?.data).toBe("CQ==");
    expect(built.lookupTables).toEqual(["E59uBXGqn83xN17kMbBVfU1M7T4wHG91eiygHb88Aovb"]);

    // the API ignoring a requested slippage override must be caught before anything is signed
    await expect(c.swapInstructions({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true, slippageBps: 5 })).rejects.toThrow(/slippage 30 ≠ requested 5/);
  });

  it("rejects instructions for a different amount or program", async () => {
    const ix = fixture("swapix-usdc-sol-whirlpool.json");
    const c = new JupiterClient({ baseUrl: "https://x.test", rps: 10, log, fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json"), "/swap-instructions": () => ix }) });
    const q = await c.quote(baseReq, null, "jupiter");
    await expect(c.swapInstructions({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true })).rejects.toThrow(/instruction input/);
    const bad = { ...fixture("swapix-sol-usdc-raydium.json") };
    bad.swapInstruction = { ...(bad.swapInstruction as object), programId: "11111111111111111111111111111111" };
    const c2 = new JupiterClient({ baseUrl: "https://x.test", rps: 10, log, fetchImpl: fakeFetch({ "/quote": () => fixture("quote-sol-usdc-raydium.json"), "/swap-instructions": () => bad }) });
    const q2 = await c2.quote(baseReq, null, "jupiter");
    await expect(c2.swapInstructions({ quote: q2, userPublicKey: USER, wrapAndUnwrapSol: true })).rejects.toThrow(/unexpected swap program/);
  });

  it("token-ledger leg: sells exactly what the previous leg delivered, minimum output still verified", async () => {
    const calls: { url: URL; body: unknown }[] = [];
    const c = new JupiterClient({
      baseUrl: "https://x.test",
      rps: 10,
      log,
      fetchImpl: fakeFetch({ "/quote": () => fixture("quote-usdc-sol-whirlpool-10bps.json"), "/swap-instructions": () => fixture("swapix-usdc-sol-whirlpool-ledger.json") }, calls),
    });
    const q = await c.quote({ ...baseReq, inputMint: USDC_MINT, outputMint: SOL_MINT, inputDecimals: 6, outputDecimals: 9, amount: 2_000_000n, slippageBps: 10 }, ["Whirlpool"], "orca");
    const built = await c.swapInstructions({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true, useTokenLedger: true });
    expect((calls[1]?.body as { useTokenLedger?: boolean }).useTokenLedger).toBe(true);
    expect(built.tokenLedger?.programId).toBe("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(built.minOutputAmount).toBe(minOutForSlippage(16_406_947n, 10));
    const args = decodeRouteArgs(built.swap.data);
    expect(args).toMatchObject({ instruction: "route_with_token_ledger", tokenLedger: true, inAmount: null, quotedOutAmount: 16_406_947n, slippageBps: 10 });
    // a fixed-input build must not be accepted where a ledger route was requested (and vice versa)
    await expect(c.swapInstructions({ quote: q, userPublicKey: USER, wrapAndUnwrapSol: true })).rejects.toThrow(/fixed-input/);
  });

  it("opens its circuit after repeated outages and reports unavailable", async () => {
    const f = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const c = new JupiterClient({ baseUrl: "https://x.test", rps: 100, log, fetchImpl: f });
    for (let i = 0; i < 5; i++) await expect(c.quote(baseReq, null, "jupiter")).rejects.toThrow();
    expect(c.available().ok).toBe(false);
    await expect(c.quote(baseReq, null, "jupiter")).rejects.toThrow(/unavailable/);
  });
});
