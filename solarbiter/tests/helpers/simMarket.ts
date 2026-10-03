/**
 * Simulated market for pipeline / chaos tests: constant-product pools on several DEXs whose decoded
 * state and firm quotes are mutually consistent (same reserves, same fee). Prices can drift between
 * decision and execution, adapters can fail, and quotes can be delayed — all deterministic (seeded).
 */
import type { DexAdapter, QuoteRequest } from "@solarbiter/dex";
import { SOL_MINT, seededRandom, type DexId, type PoolState, type Quote } from "@solarbiter/shared";

export const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const DECIMALS: Record<string, number> = { [SOL_MINT]: 9, [JUP]: 6 };

export interface SimPool {
  dex: DexId;
  address: string;
  /** Reserves in raw units: SOL (lamports) and token. */
  solReserve: number;
  tokenReserve: number;
  feeRate: number;
}

export class SimMarket {
  pools: SimPool[];
  /** Multiplier applied to every quote output (adverse drift between decision and execution). */
  drift = 1;
  failing = new Set<DexId>();
  quoteDelayMs = 0;
  quotes = 0;
  private readonly rnd: () => number;

  constructor(pools: SimPool[], seed = 1) {
    this.pools = pools;
    this.rnd = seededRandom(seed);
  }

  /** Random cross-DEX mispricing of up to `maxBps` on the second pool. */
  static random(seed: number, maxBps: number, depthSol = 2_000): SimMarket {
    const r = seededRandom(seed);
    const price = 1_000; // JUP per SOL (UI)
    const skew = 1 + ((r() * 2 - 1) * maxBps) / 10_000;
    const sol = depthSol * 1e9;
    return new SimMarket(
      [
        { dex: "raydium", address: "pool-ray", solReserve: sol, tokenReserve: sol * 1e-3 * price, feeRate: 0.0025 },
        { dex: "orca", address: "pool-orca", solReserve: sol, tokenReserve: sol * 1e-3 * price * skew, feeRate: 0.0004 },
      ],
      seed,
    );
  }

  states(now: number, slot = 1): PoolState[] {
    return this.pools.map((p) => ({
      pool: p.address,
      dex: p.dex,
      kind: p.dex === "orca" ? "orca_whirlpool" : "raydium_amm_v4",
      mintA: SOL_MINT,
      mintB: JUP,
      slot,
      fetchedAt: now,
      priceAInB: p.tokenReserve / 1e6 / (p.solReserve / 1e9),
      feeRate: p.feeRate,
      reserveA: p.solReserve / 1e9,
      reserveB: p.tokenReserve / 1e6,
      liquidity: null,
      active: true,
    }));
  }

  /** Constant-product output, fee taken from the input. */
  out(pool: SimPool, inputMint: string, amount: bigint): bigint {
    const x = Number(amount) * (1 - pool.feeRate);
    const [rin, rout] = inputMint === SOL_MINT ? [pool.solReserve, pool.tokenReserve] : [pool.tokenReserve, pool.solReserve];
    return BigInt(Math.floor(((rout * x) / (rin + x)) * this.drift));
  }

  adapter(dex: DexId, now: () => number): DexAdapter {
    const market = this;
    return {
      id: dex,
      labels: [dex],
      poolKinds: [],
      available: () => (market.failing.has(dex) ? { ok: false, reason: "simulated outage" } : { ok: true, reason: null }),
      async getQuote(req: QuoteRequest): Promise<Quote> {
        if (market.failing.has(dex)) throw Object.assign(new Error("simulated outage"), { code: "ROUTE_UNAVAILABLE" });
        market.quotes++;
        const pool = market.pools.find((p) => p.dex === dex);
        if (!pool) throw new Error("no pool");
        const out = market.out(pool, req.inputMint, req.amount);
        return {
          id: `q${market.quotes}`,
          kind: "firm",
          timestamp: now() - market.quoteDelayMs,
          slot: 1,
          source: dex,
          inputMint: req.inputMint,
          outputMint: req.outputMint,
          inputAmount: req.amount,
          outputAmount: out,
          minOutputAmount: (out * BigInt(10_000 - req.slippageBps)) / 10_000n,
          slippageBps: req.slippageBps,
          price: Number(out) / 10 ** req.outputDecimals / (Number(req.amount) / 10 ** req.inputDecimals),
          priceImpact: 0,
          feeRates: [pool.feeRate],
          route: [{ dex, label: dex, pool: pool.address, inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out }],
          latencyMs: 40,
        };
      },
      buildSwap: () => Promise.reject(new Error("not used in simulation")),
      getLiquidity: (p) => ({ pool: p.address, tvlUsd: 0, reserveA: null, reserveB: null, depth1pctA: null }),
      getFees: () => ({ feeRate: 0, source: "sim" }),
      validateRoute: (q, e) => ({ ok: q.inputMint === e.inputMint && q.outputMint === e.outputMint, reasons: [] }),
      discoverPools: async () => [],
      stateAccounts: () => [],
      decodeState: () => null,
    };
  }

  /** Random adverse/favourable move for the next execution (bps, symmetric). */
  randomDrift(maxBps: number): void {
    this.drift = 1 + ((this.rnd() * 2 - 1) * maxBps) / 10_000;
  }
}
