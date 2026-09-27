import type { Logger } from "pino";
import type { RpcManager } from "./rpcManager.js";

/** Fee market snapshot in micro-lamports per compute unit. */
export interface FeeMarketSnapshot {
  ts: number;
  slot: number | null;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  samples: number;
}

export interface PriorityFeeChoice {
  microLamportsPerCu: number;
  totalLamports: bigint;
  percentileUsed: number;
  capped: boolean;
  reason: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx] as number;
}

export function snapshotFromSamples(samples: { slot: number; prioritizationFee: number }[], ts: number): FeeMarketSnapshot {
  const fees = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
  return {
    ts,
    slot: samples.length ? Math.max(...samples.map((s) => s.slot)) : null,
    p25: percentile(fees, 25),
    p50: percentile(fees, 50),
    p75: percentile(fees, 75),
    p90: percentile(fees, 90),
    max: fees.length ? (fees[fees.length - 1] as number) : 0,
    samples: fees.length,
  };
}

/** Interpolated fee level for an arbitrary percentile from the snapshot's anchor points. */
export function feeAtPercentile(s: FeeMarketSnapshot, p: number): number {
  const pts: [number, number][] = [
    [0, 0],
    [25, s.p25],
    [50, s.p50],
    [75, s.p75],
    [90, s.p90],
    [100, s.max],
  ];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i] as [number, number];
    const [x0, y0] = pts[i - 1] as [number, number];
    if (p <= x1) return y0 + ((y1 - y0) * (p - x0)) / Math.max(1e-9, x1 - x0);
  }
  return s.max;
}

export function priorityFeeLamports(microLamportsPerCu: number, computeUnits: number): bigint {
  return BigInt(Math.ceil((microLamportsPerCu * computeUnits) / 1_000_000));
}

/**
 * Economically justified priority fee: the configured market percentile, raised for valuable
 * opportunities (more competition), never above the hard cap nor above a share of the expected profit.
 * Never "pay the maximum" by default.
 */
export function choosePriorityFee(opts: {
  market: FeeMarketSnapshot | null;
  basePercentile: number;
  computeUnits: number;
  maxFeeLamports: number;
  expectedProfitLamports: bigint;
  /** Max share of the expected profit the priority fee may consume. */
  maxShareOfProfit: number;
}): PriorityFeeChoice {
  const cu = Math.max(1, opts.computeUnits);
  if (!opts.market || opts.market.samples === 0) {
    return { microLamportsPerCu: 0, totalLamports: 0n, percentileUsed: 0, capped: false, reason: "no fee market data — no priority fee" };
  }
  // valuable opportunities attract competition: move up to +25 percentile points
  const profit = Number(opts.expectedProfitLamports);
  const boost = profit > 0 ? Math.min(25, Math.log10(1 + profit / 10_000) * 10) : 0;
  const pct = Math.min(95, opts.basePercentile + boost);
  let micro = Math.ceil(feeAtPercentile(opts.market, pct));
  let total = priorityFeeLamports(micro, cu);
  const capByProfit = profit > 0 ? BigInt(Math.floor(profit * opts.maxShareOfProfit)) : 0n;
  const cap = BigInt(opts.maxFeeLamports) < capByProfit ? BigInt(opts.maxFeeLamports) : capByProfit;
  let capped = false;
  if (total > cap) {
    capped = true;
    micro = Math.floor((Number(cap) * 1_000_000) / cu);
    total = priorityFeeLamports(micro, cu);
  }
  return { microLamportsPerCu: micro, totalLamports: total, percentileUsed: Math.round(pct), capped, reason: capped ? "capped by limit / profit share" : `market p${Math.round(pct)}` };
}

/** Samples the priority fee market (global and per-account scopes) with a short cache. */
export class PriorityFeeOracle {
  private last: FeeMarketSnapshot | null = null;
  private readonly scoped = new Map<string, FeeMarketSnapshot>();

  constructor(
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    private readonly maxAgeMs = 10_000,
  ) {}

  latest(): FeeMarketSnapshot | null {
    return this.last;
  }

  async sample(accounts: string[] = []): Promise<FeeMarketSnapshot> {
    const key = [...accounts].sort().join(",");
    const cached = key ? this.scoped.get(key) : this.last;
    if (cached && Date.now() - cached.ts < this.maxAgeMs) return cached;
    const samples = await this.rpc.getRecentPrioritizationFees(accounts);
    const snap = snapshotFromSamples(samples, Date.now());
    if (key) this.scoped.set(key, snap);
    else this.last = snap;
    if (this.scoped.size > 200) this.scoped.clear();
    this.log.debug({ scope: key || "global", p50: snap.p50, p90: snap.p90 }, "fee market sampled");
    return snap;
  }
}
