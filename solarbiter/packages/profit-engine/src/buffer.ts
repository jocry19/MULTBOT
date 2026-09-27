/**
 * Dynamic safety buffer (bps of trade size). The buffer grows with everything that makes the
 * expected profit less certain; every component is reported so the UI can explain it.
 */
export interface SafetyBufferInputs {
  baseBps: number;
  /** Learned uncertainty of slippage (std of realised − expected, bps); 0 until trained. */
  slippageStdBps: number;
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
  /** Learned success share of this route/venue pair (0..1); 1 = fully reliable. */
  routeReliability: number;
  atomic: boolean;
  nonAtomicExtraBps: number;
}

export interface SafetyBuffer {
  bps: number;
  components: { base: number; slippageUncertainty: number; quoteAge: number; routeReliability: number; nonAtomic: number };
}

export function dynamicSafetyBufferBps(i: SafetyBufferInputs): SafetyBuffer {
  const base = Math.max(0, i.baseBps);
  const slippageUncertainty = Math.max(0, i.slippageStdBps);
  const quoteAge = i.maxQuoteAgeMs > 0 ? base * Math.min(1, Math.max(0, i.quoteAgeMs / i.maxQuoteAgeMs)) : 0;
  const routeReliability = 10 * (1 - Math.min(1, Math.max(0, i.routeReliability)));
  const nonAtomic = i.atomic ? 0 : Math.max(0, i.nonAtomicExtraBps);
  const components = { base, slippageUncertainty, quoteAge, routeReliability, nonAtomic };
  return { bps: base + slippageUncertainty + quoteAge + routeReliability + nonAtomic, components };
}
