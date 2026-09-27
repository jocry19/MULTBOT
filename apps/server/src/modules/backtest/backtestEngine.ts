import type { ExitReason, PerformanceStats, StrategySpec } from "@multbot/shared";
import {
  simulateEntry,
  simulateExit,
  tradeResult,
  type EntryFill,
  type ExecutionParams,
  type ExitFill,
  type HistoricalMarketView,
  type TradeResult,
} from "../execution/simulator.js";
import type { FeatureVector } from "../features/types.js";
import { hashSeed, performance, seededRandom } from "../stats/stats.js";
import { invalidated, matchSpec } from "../strategy/evaluate.js";

/**
 * Event-driven, strictly causal backtest of a strategy spec.
 *
 * Decision points are the recorded research samples (features computed live at that time, same
 * schedule as paper/live trading). Entries/exits are simulated against real on-chain states after
 * the execution delay; exits are triggered trade by trade (TP / SL / trailing / invalidation /
 * max hold) using only information available at the trigger time. Portfolio constraints (max
 * open positions, one position per token, cooldown) and random failed transactions are applied.
 */

export interface DecisionSample {
  id: number;
  ts: number;
  mint: string;
  venue: "pump_curve" | "pump_amm";
  ageSec: number;
  features: FeatureVector;
  regimeLabel: string | null;
}

export interface BacktestConfig {
  positionSizeSol: number;
  maxOpenPositions: number;
  exec: ExecutionParams;
  /** Simulate random failed transactions (deterministic by seed). */
  randomFailures: boolean;
  seed: string;
}

export interface BacktestTrade {
  seq: number;
  mint: string;
  sampleId: number;
  decisionTs: number;
  entry: EntryFill | null;
  exit: ExitFill | null;
  exitReason: ExitReason | "ENTRY_FAILED" | "EXIT_FAILED";
  result: TradeResult | null;
  /** Net SOL for this trade (failed entries: fees burnt). */
  netSol: number;
  netReturn: number;
  regimeLabel: string | null;
  failed: boolean;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  stats: PerformanceStats;
  returnStats: PerformanceStats;
  equity: { ts: number; equity: number }[];
  costs: Record<string, number>;
  regimes: { label: string; n: number; netSol: number; winRate: number }[];
  exitReasons: Record<string, number>;
  failedEntries: number;
  skipped: { cooldown: number; capacity: number; holding: number };
  avgOpenPositions: number;
  period: { from: number; to: number };
}

interface OpenPosition {
  mint: string;
  exitTs: number;
}

export function runBacktest(
  spec: StrategySpec,
  samples: DecisionSample[],
  view: HistoricalMarketView,
  cfg: BacktestConfig,
): BacktestResult {
  const rnd = cfg.randomFailures ? seededRandom(hashSeed(cfg.seed)) : undefined;
  const bySample = [...samples].sort((a, b) => a.ts - b.ts);
  const samplesByMint = new Map<string, DecisionSample[]>();
  for (const s of bySample) {
    const arr = samplesByMint.get(s.mint) ?? [];
    arr.push(s);
    samplesByMint.set(s.mint, arr);
  }
  const lastEntry = new Map<string, number>();
  let open: OpenPosition[] = [];
  const trades: BacktestTrade[] = [];
  const skipped = { cooldown: 0, capacity: 0, holding: 0 };
  let openSum = 0;
  let openObs = 0;

  for (const s of bySample) {
    open = open.filter((p) => p.exitTs > s.ts);
    openSum += open.length;
    openObs++;
    const m = matchSpec(spec, s.features, s.venue, s.ageSec);
    if (!m.matched) continue;
    if (open.some((p) => p.mint === s.mint)) {
      skipped.holding++;
      continue;
    }
    const last = lastEntry.get(s.mint);
    if (last !== undefined && s.ts - last < spec.entry.cooldownSec * 1000) {
      skipped.cooldown++;
      continue;
    }
    if (open.length >= cfg.maxOpenPositions) {
      skipped.capacity++;
      continue;
    }
    lastEntry.set(s.mint, s.ts);
    const entry = simulateEntry(view, s.mint, s.ts, cfg.positionSizeSol, cfg.exec, rnd);
    const seq = trades.length + 1;
    if (!entry.ok) {
      trades.push({
        seq,
        mint: s.mint,
        sampleId: s.id,
        decisionTs: s.ts,
        entry: null,
        exit: null,
        exitReason: "ENTRY_FAILED",
        result: null,
        netSol: -entry.costSol,
        netReturn: -entry.costSol / cfg.positionSizeSol,
        regimeLabel: s.regimeLabel,
        failed: true,
      });
      continue;
    }
    const { exitDecisionTs, reason } = findExit(spec, entry, view, samplesByMint.get(s.mint) ?? []);
    const exit = simulateExit(view, s.mint, entry.tokens, exitDecisionTs, cfg.exec, rnd);
    if (!exit.ok) {
      const lost = entry.swapSol + entry.priorityFeeSol + entry.networkFeeSol + entry.rentSol + exit.costSol;
      trades.push({
        seq,
        mint: s.mint,
        sampleId: s.id,
        decisionTs: s.ts,
        entry,
        exit: null,
        exitReason: "EXIT_FAILED",
        result: null,
        netSol: -lost,
        netReturn: -lost / cfg.positionSizeSol,
        regimeLabel: s.regimeLabel,
        failed: true,
      });
      open.push({ mint: s.mint, exitTs: exit.execTs });
      continue;
    }
    const result = tradeResult(entry, exit);
    trades.push({
      seq,
      mint: s.mint,
      sampleId: s.id,
      decisionTs: s.ts,
      entry,
      exit,
      exitReason: reason,
      result,
      netSol: result.netPnlSol,
      netReturn: result.netReturn,
      regimeLabel: s.regimeLabel,
      failed: false,
    });
    open.push({ mint: s.mint, exitTs: exit.execTs });
  }

  // equity curve in exit order
  const closed = [...trades].sort((a, b) => (a.exit?.execTs ?? a.decisionTs) - (b.exit?.execTs ?? b.decisionTs));
  let eq = 0;
  const equity = closed.map((t) => {
    eq += t.netSol;
    return { ts: t.exit?.execTs ?? t.decisionTs, equity: eq };
  });
  const costs: Record<string, number> = {};
  for (const t of trades) {
    if (!t.result) continue;
    for (const [k, v] of Object.entries(t.result.costs)) costs[k] = (costs[k] ?? 0) + v;
  }
  const regimeMap = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const k = t.regimeLabel ?? "unknown";
    regimeMap.set(k, [...(regimeMap.get(k) ?? []), t]);
  }
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  return {
    trades,
    stats: performance(closed.map((t) => t.netSol)),
    returnStats: performance(closed.map((t) => t.netReturn)),
    equity,
    costs,
    regimes: [...regimeMap.entries()].map(([label, ts]) => ({
      label,
      n: ts.length,
      netSol: ts.reduce((s, t) => s + t.netSol, 0),
      winRate: ts.filter((t) => t.netSol > 0).length / ts.length,
    })),
    exitReasons,
    failedEntries: trades.filter((t) => t.exitReason === "ENTRY_FAILED").length,
    skipped,
    avgOpenPositions: openObs > 0 ? openSum / openObs : 0,
    period: { from: bySample[0]?.ts ?? 0, to: bySample[bySample.length - 1]?.ts ?? 0 },
  };
}

/**
 * Determine the exit decision time by walking forward trade by trade (causal: every trigger only
 * uses prices/features known at that moment).
 */
export function findExit(
  spec: StrategySpec,
  entry: EntryFill,
  view: HistoricalMarketView,
  laterSamples: DecisionSample[],
): { exitDecisionTs: number; reason: ExitReason } {
  const maxTs = entry.execTs + spec.exit.maxHoldSec * 1000;
  const ref = entry.effectivePrice;
  const tp = spec.exit.takeProfitPct;
  const sl = spec.exit.stopLossPct;
  const trail = spec.exit.trailingStopPct;
  let peak = entry.spotPrice;
  const mint = entry.mint;
  const arr = view.tradesOf(mint);
  let sIdx = laterSamples.findIndex((s) => s.ts > entry.execTs);
  if (sIdx < 0) sIdx = laterSamples.length;
  for (let i = view.indexAt(mint, entry.execTs) + 1; i < arr.length; i++) {
    const t = arr[i];
    if (!t || t.ts > maxTs) break;
    // invalidation checks at decision samples before this trade
    while (sIdx < laterSamples.length && (laterSamples[sIdx] as DecisionSample).ts <= t.ts) {
      const sample = laterSamples[sIdx] as DecisionSample;
      if (sample.ts > maxTs) break;
      if (invalidated(spec, sample.features)) return { exitDecisionTs: sample.ts, reason: "SIGNAL_INVALIDATED" };
      sIdx++;
    }
    const p = t.priceSol;
    if (p > peak) peak = p;
    if (tp !== undefined && p >= ref * (1 + tp)) return { exitDecisionTs: t.ts, reason: "TAKE_PROFIT" };
    if (sl !== undefined && p <= ref * (1 - sl)) return { exitDecisionTs: t.ts, reason: "STOP_LOSS" };
    if (trail !== undefined && p <= peak * (1 - trail) && peak > ref) return { exitDecisionTs: t.ts, reason: "TRAILING_STOP" };
  }
  while (sIdx < laterSamples.length && (laterSamples[sIdx] as DecisionSample).ts <= maxTs) {
    const sample = laterSamples[sIdx] as DecisionSample;
    if (invalidated(spec, sample.features)) return { exitDecisionTs: sample.ts, reason: "SIGNAL_INVALIDATED" };
    sIdx++;
  }
  return { exitDecisionTs: maxTs, reason: "MAX_HOLD" };
}

