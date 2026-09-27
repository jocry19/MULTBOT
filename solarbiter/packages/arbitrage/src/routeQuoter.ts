import type { DexRegistry } from "@solarbiter/dex";
import type { QuotePriority } from "@solarbiter/quotes";
import type { DexId, Quote } from "@solarbiter/shared";

export interface RouteHopSpec {
  dex: DexId;
  inputMint: string;
  outputMint: string;
}

export interface QuotedRoute {
  legs: Quote[];
  inputLamports: bigint;
  /** Expected SOL out of the last leg. */
  outputLamports: bigint;
  /** Timestamp of the first (oldest) leg. */
  oldestQuoteAt: number;
  latencyMs: number;
}

export class RouteQuoteError extends Error {
  constructor(
    readonly code: "ROUTE_UNAVAILABLE" | "QUOTE_BUDGET_EXHAUSTED",
    message: string,
  ) {
    super(message);
    this.name = "RouteQuoteError";
  }
}

export interface RouteQuoteOptions {
  legSlippageBps: number;
  forJitoBundle: boolean;
  priority: QuotePriority;
  maxWaitMs: number;
  decimals: (mint: string) => number | undefined;
}

/**
 * Accounts budget per leg so that all legs + compute budget + tip fit into ONE transaction
 * (atomic execution).
 */
export function maxAccountsPerLeg(legs: number): number {
  return legs <= 2 ? 28 : legs === 3 ? 18 : 13;
}

/**
 * Chained firm quotes, one per hop, each restricted to its DEX and to a single pool hop.
 *
 * Amounts follow exactly what execution will do:
 *   - the first leg sells the trade size
 *   - intermediate legs sell the previous leg's guaranteed minimum (fixed input)
 *   - the closing leg sells whatever the previous leg delivered (token ledger), so it is quoted
 *     with the previous leg's expected output
 */
export async function quoteRoute(registry: DexRegistry, hops: RouteHopSpec[], inputLamports: bigint, o: RouteQuoteOptions): Promise<QuotedRoute> {
  const legs: Quote[] = [];
  let amount = inputLamports;
  let latency = 0;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i] as RouteHopSpec;
    const adapter = registry.get(hop.dex);
    if (!adapter) throw new RouteQuoteError("ROUTE_UNAVAILABLE", `no adapter for ${hop.dex}`);
    const avail = adapter.available();
    if (!avail.ok) throw new RouteQuoteError("ROUTE_UNAVAILABLE", `${hop.dex} unavailable: ${avail.reason}`);
    const inDec = o.decimals(hop.inputMint);
    const outDec = o.decimals(hop.outputMint);
    if (inDec === undefined || outDec === undefined) throw new RouteQuoteError("ROUTE_UNAVAILABLE", "unknown token decimals");
    let q: Quote;
    try {
      q = await adapter.getQuote({
        inputMint: hop.inputMint,
        outputMint: hop.outputMint,
        inputDecimals: inDec,
        outputDecimals: outDec,
        amount,
        slippageBps: o.legSlippageBps,
        onlyDirectRoutes: true,
        maxAccounts: maxAccountsPerLeg(hops.length),
        forJitoBundle: o.forJitoBundle,
        priority: o.priority,
        maxWaitMs: o.maxWaitMs,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "QUOTE_BUDGET_EXHAUSTED") throw new RouteQuoteError("QUOTE_BUDGET_EXHAUSTED", (err as Error).message);
      throw new RouteQuoteError("ROUTE_UNAVAILABLE", `${hop.dex} ${hop.inputMint.slice(0, 4)}→${hop.outputMint.slice(0, 4)}: ${(err as Error).message}`);
    }
    const v = adapter.validateRoute(q, { inputMint: hop.inputMint, outputMint: hop.outputMint, maxHops: 1 });
    if (!v.ok) throw new RouteQuoteError("ROUTE_UNAVAILABLE", `route rejected: ${v.reasons.join("; ")}`);
    legs.push(q);
    latency += q.latencyMs;
    const nextIsLast = i + 1 === hops.length - 1;
    amount = nextIsLast ? q.outputAmount : q.minOutputAmount;
    if (amount <= 0n) throw new RouteQuoteError("ROUTE_UNAVAILABLE", "zero output");
  }
  const last = legs[legs.length - 1] as Quote;
  return { legs, inputLamports, outputLamports: last.outputAmount, oldestQuoteAt: Math.min(...legs.map((l) => l.timestamp)), latencyMs: latency };
}
