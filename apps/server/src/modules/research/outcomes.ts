import {
  simulateEntry,
  simulateExit,
  tradeResult,
  type EntryFill,
  type ExecutionParams,
  type HistoricalMarketView,
} from "../execution/simulator.js";

/**
 * Forward outcomes of a decision point with realistic execution.
 *
 * For every horizon H the outcome is: buy `positionSol` at decision + delay, sell everything at
 * decision + delay + H — both against the actual on-chain state — minus all costs. Failed
 * transactions enter as expected value: E[net] = (1 − q)·net + q·(−fees of the failed attempt).
 * Additionally a take-profit / stop-loss grid and the price path (t+1s … t+24h) are recorded.
 */

export const OUTCOME_HORIZONS_SEC = [30, 60, 120, 300, 900, 1800, 3600] as const;
export const PATH_OFFSETS_SEC = [0, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 6 * 3600, 24 * 3600] as const;
export const TPSL_HORIZONS_SEC = [300, 900, 3600] as const;
export const TP_LEVELS = [0.2, 0.5, 1.0] as const;
export const SL_LEVELS = [0.1, 0.2, 0.35] as const;

export function tpslKey(h: number, tp: number, sl: number): string {
  return `${h}:${tp}:${sl}`;
}

export interface HorizonOutcome {
  /** Expected net SOL (incl. failed-tx expectation). */
  net: number;
  /** Expected net return relative to the position size. */
  ret: number;
  gross: number;
  exitSpot: number;
  /** Max spot price relative to the entry spot within the horizon. */
  maxRunup: number;
  maxDrawdown: number;
  tPeakSec: number;
  /** True if the horizon overlapped a data gap (excluded from research). */
  gap?: boolean;
}

export interface SampleOutcome {
  v: 1;
  positionSol: number;
  params: { delayMs: number; failedTxRate: number; priorityFeeSol: number; mevBps: number };
  entry: { ok: boolean; reason?: string; execTs?: number; spot?: number; effectivePrice?: number; tokens?: number; venue?: string };
  horizons: Record<string, HorizonOutcome>;
  /** TP/SL grid: key "H:tp:sl" → expected net return. */
  tpsl: Record<string, number>;
  /** Spot price at t + offset (seconds), null if no trade by then. */
  path: Record<string, number | null>;
  /** Horizons (seconds) not yet computable (still in the future at labelling time). */
  pending: number[];
}

export interface OutcomeOptions {
  positionSol: number;
  exec: ExecutionParams;
  /** Latest time for which market data is complete (horizons ending later stay pending). */
  dataUntil: number;
  isGap?: (from: number, to: number) => boolean;
}

function pathStats(view: HistoricalMarketView, mint: string, from: number, to: number, ref: number): { maxRunup: number; maxDrawdown: number; tPeakSec: number } {
  const trades = view.tradesOf(mint);
  let i = view.indexAt(mint, from) + 1;
  let hi = ref;
  let lo = ref;
  let tPeak = from;
  for (; i < trades.length; i++) {
    const t = trades[i];
    if (!t || t.ts > to) break;
    if (t.priceSol > hi) {
      hi = t.priceSol;
      tPeak = t.ts;
    }
    if (t.priceSol < lo) lo = t.priceSol;
  }
  return { maxRunup: ref > 0 ? hi / ref - 1 : 0, maxDrawdown: ref > 0 ? lo / ref - 1 : 0, tPeakSec: (tPeak - from) / 1000 };
}

function expected(netSuccess: number, failCost: number, q: number): number {
  return (1 - q) * netSuccess + q * -failCost;
}

/** Time of the first trade after `from` crossing TP or SL (relative to `ref`), or null. */
function firstCross(view: HistoricalMarketView, mint: string, from: number, to: number, ref: number, tp: number, sl: number): number | null {
  const trades = view.tradesOf(mint);
  for (let i = view.indexAt(mint, from) + 1; i < trades.length; i++) {
    const t = trades[i];
    if (!t || t.ts > to) break;
    if (t.priceSol >= ref * (1 + tp) || t.priceSol <= ref * (1 - sl)) return t.ts;
  }
  return null;
}

export function computeOutcome(view: HistoricalMarketView, mint: string, ts: number, opts: OutcomeOptions): SampleOutcome {
  const { exec, positionSol } = opts;
  const q = exec.failedTxRate;
  const failCost = exec.priorityFeeSol + exec.signatures * 0.000005;
  const out: SampleOutcome = {
    v: 1,
    positionSol,
    params: { delayMs: exec.executionDelayMs, failedTxRate: q, priorityFeeSol: exec.priorityFeeSol, mevBps: exec.mevImpactBps },
    entry: { ok: false },
    horizons: {},
    tpsl: {},
    path: {},
    pending: [],
  };
  for (const off of PATH_OFFSETS_SEC) {
    const t = ts + off * 1000;
    out.path[String(off)] = t <= opts.dataUntil ? (view.stateAt(mint, t)?.priceSol ?? null) : null;
  }
  // deterministic (no random failures): failures enter as expectation below
  const entry = simulateEntry(view, mint, ts, positionSol, { ...exec, failedTxRate: 0 });
  if (!entry.ok) {
    out.entry = { ok: false, reason: entry.reason };
    return out;
  }
  const e = entry as EntryFill;
  out.entry = { ok: true, execTs: e.execTs, spot: e.spotPrice, effectivePrice: e.effectivePrice, tokens: e.tokens, venue: e.venue };
  const exitCostRetry = (q / (1 - q)) * failCost; // expected extra cost of retried exits

  for (const h of OUTCOME_HORIZONS_SEC) {
    const exitDecision = e.execTs + h * 1000;
    const exitEnd = exitDecision + exec.executionDelayMs;
    if (exitEnd > opts.dataUntil) {
      out.pending.push(h);
      continue;
    }
    const x = simulateExit(view, mint, e.tokens, exitDecision, { ...exec, failedTxRate: 0 });
    let netSuccess: number;
    let gross: number;
    let exitSpot: number;
    if (x.ok) {
      const r = tradeResult(e, x);
      netSuccess = r.netPnlSol - exitCostRetry;
      gross = r.grossPnlSol;
      exitSpot = x.spotPrice;
    } else {
      // cannot exit (no liquidity / never migrated): position is worthless
      netSuccess = -(e.swapSol + e.priorityFeeSol + e.networkFeeSol + e.rentSol) - failCost;
      gross = -e.swapSol;
      exitSpot = 0;
    }
    const net = expected(netSuccess, failCost, q);
    const ps = pathStats(view, mint, e.execTs, exitDecision, e.spotPrice);
    const ho: HorizonOutcome = { net, ret: net / positionSol, gross, exitSpot, ...ps };
    if (opts.isGap?.(ts, exitEnd)) ho.gap = true;
    out.horizons[String(h)] = ho;
  }

  for (const h of TPSL_HORIZONS_SEC) {
    const end = e.execTs + h * 1000;
    if (end + exec.executionDelayMs > opts.dataUntil) continue;
    for (const tp of TP_LEVELS) {
      for (const sl of SL_LEVELS) {
        const cross = firstCross(view, mint, e.execTs, end, e.effectivePrice, tp, sl);
        const exitDecision = cross ?? end;
        const x = simulateExit(view, mint, e.tokens, exitDecision, { ...exec, failedTxRate: 0 });
        const netSuccess = x.ok
          ? tradeResult(e, x).netPnlSol - exitCostRetry
          : -(e.swapSol + e.priorityFeeSol + e.networkFeeSol + e.rentSol) - failCost;
        out.tpsl[tpslKey(h, tp, sl)] = expected(netSuccess, failCost, q) / positionSol;
      }
    }
  }
  return out;
}
