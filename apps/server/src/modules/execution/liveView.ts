import type { MarketState } from "../market/marketState.js";
import type { MarketView, VenueState } from "./simulator.js";

/**
 * Market view over the live in-memory market state: always the latest known on-chain state of the
 * token (the `t` argument is ignored — live fills happen "now", after the real execution delay).
 */
export class LiveMarketView implements MarketView {
  constructor(private readonly market: MarketState) {}

  stateAt(mint: string): VenueState | null {
    const t = this.market.tokens.get(mint);
    if (!t || t.lastTradeAt === 0) return null;
    const feeBps = t.lastFeeBps ?? 125;
    if (t.venue === "pump_amm") {
      if (!t.poolState) return null;
      return {
        venue: "pump_amm",
        curve: null,
        pool: t.poolState,
        feeBps,
        priceSol: t.lastPrice,
        decimals: t.decimals,
        ts: t.lastTradeAt,
        tradable: t.poolState.baseReserves > 0n,
      };
    }
    if (!t.curve) return null;
    return {
      venue: "pump_curve",
      curve: t.curve,
      pool: null,
      feeBps,
      priceSol: t.lastPrice,
      decimals: t.decimals,
      ts: t.lastTradeAt,
      tradable: !t.curve.complete && !t.complete,
    };
  }
}
