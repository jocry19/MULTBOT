import { SOL_MINT, type DexId, type PoolKind, type PoolState, type StrategyType } from "@solarbiter/shared";

/** One swap of a screened route, priced from decoded pool state. */
export interface ScreenHop {
  pool: string;
  dex: DexId;
  kind: PoolKind;
  inputMint: string;
  outputMint: string;
  /** Output per input at the marginal price (UI units). */
  midRate: number;
  feeRate: number;
  /** midRate × (1 − fee). */
  rate: number;
  slot: number;
  fetchedAt: number;
}

export interface Candidate {
  /** Stable identity: strategy, mint path and venue path. */
  key: string;
  strategyType: StrategyType;
  hops: ScreenHop[];
  /** Mint path, SOL first and last. */
  route: string[];
  dexes: DexId[];
  /** First intermediate token. */
  tokenMint: string;
  /** Round-trip spread at marginal prices before fees (bps). */
  midSpreadBps: number;
  /** Round-trip spread after pool fees (bps) — the screening criterion. */
  netSpreadBps: number;
  feeRates: number[];
  slot: number;
  oldestStateAt: number;
  detectedAt: number;
}

export interface ScreenStats {
  pairsScreened: number;
  belowThreshold: number;
  candidates: number;
}

interface Edge extends ScreenHop {}

function edgesFrom(states: PoolState[]): Edge[] {
  const out: Edge[] = [];
  for (const s of states) {
    if (!s.active || !(s.priceAInB > 0) || !Number.isFinite(s.priceAInB)) continue;
    const base = { pool: s.pool, dex: s.dex, kind: s.kind, feeRate: s.feeRate, slot: s.slot, fetchedAt: s.fetchedAt };
    out.push({ ...base, inputMint: s.mintA, outputMint: s.mintB, midRate: s.priceAInB, rate: s.priceAInB * (1 - s.feeRate) });
    out.push({ ...base, inputMint: s.mintB, outputMint: s.mintA, midRate: 1 / s.priceAInB, rate: (1 / s.priceAInB) * (1 - s.feeRate) });
  }
  return out;
}

function candidateOf(strategyType: StrategyType, hops: ScreenHop[], now: number): Candidate {
  const mid = hops.reduce((a, h) => a * h.midRate, 1);
  const net = hops.reduce((a, h) => a * h.rate, 1);
  const route = [hops[0]?.inputMint as string, ...hops.map((h) => h.outputMint)];
  const dexes = hops.map((h) => h.dex);
  return {
    key: `${strategyType}:${route.join(">")}:${dexes.join(">")}`,
    strategyType,
    hops,
    route,
    dexes,
    tokenMint: route[1] as string,
    midSpreadBps: (mid - 1) * 10_000,
    netSpreadBps: (net - 1) * 10_000,
    feeRates: hops.map((h) => h.feeRate),
    slot: Math.min(...hops.map((h) => h.slot)),
    oldestStateAt: Math.min(...hops.map((h) => h.fetchedAt)),
    detectedAt: now,
  };
}

/** Best (highest rate) edge per directed pair and DEX: firm quotes are per DEX, not per pool. */
function bestByPairAndDex(edges: Edge[]): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.inputMint}>${e.outputMint}@${e.dex}`;
    const cur = m.get(k);
    if (!cur || e.rate > cur.rate) m.set(k, e);
  }
  return m;
}

export interface ScreenOptions {
  minNetSpreadBps: number;
  direct: boolean;
  triangular: boolean;
  maxSwaps: number;
  /** Tokens allowed as intermediates (safe tokens). SOL is always the base. */
  tradable: (mint: string) => boolean;
  now: number;
}

/**
 * Screening on marginal prices. Direct: SOL → T on DEX X, T → SOL on DEX Y (X ≠ Y).
 * Triangular: SOL → A → B (→ C) → SOL across any venues. Only routes whose spread after pool fees
 * clears the threshold become candidates for firm quotes; everything else is counted for the
 * "WHY NO TRADE?" statistics (SPREAD_TOO_SMALL).
 */
export function screen(states: PoolState[], o: ScreenOptions): { candidates: Candidate[]; stats: ScreenStats } {
  const best = [...bestByPairAndDex(edgesFrom(states)).values()].filter((e) => (e.inputMint === SOL_MINT || o.tradable(e.inputMint)) && (e.outputMint === SOL_MINT || o.tradable(e.outputMint)));
  const from = new Map<string, Edge[]>();
  for (const e of best) {
    const list = from.get(e.inputMint) ?? [];
    list.push(e);
    from.set(e.inputMint, list);
  }
  const stats: ScreenStats = { pairsScreened: 0, belowThreshold: 0, candidates: 0 };
  const candidates: Candidate[] = [];
  const consider = (type: StrategyType, hops: ScreenHop[]) => {
    stats.pairsScreened++;
    const c = candidateOf(type, hops, o.now);
    if (c.netSpreadBps >= o.minNetSpreadBps) candidates.push(c);
    else stats.belowThreshold++;
  };

  if (o.direct) {
    for (const buy of from.get(SOL_MINT) ?? []) {
      for (const sell of from.get(buy.outputMint) ?? []) {
        if (sell.outputMint !== SOL_MINT || sell.dex === buy.dex) continue;
        consider("direct", [buy, sell]);
      }
    }
  }

  if (o.triangular && o.maxSwaps >= 3) {
    const walk = (path: Edge[], visited: Set<string>) => {
      const last = path[path.length - 1] as Edge;
      for (const e of from.get(last.outputMint) ?? []) {
        if (e.outputMint === SOL_MINT) {
          if (path.length + 1 >= 3) consider("triangular", [...path, e]);
          continue;
        }
        if (path.length + 1 >= o.maxSwaps || visited.has(e.outputMint)) continue;
        visited.add(e.outputMint);
        walk([...path, e], visited);
        visited.delete(e.outputMint);
      }
    };
    for (const first of from.get(SOL_MINT) ?? []) walk([first], new Set([SOL_MINT, first.outputMint]));
  }

  candidates.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
  stats.candidates = candidates.length;
  return { candidates, stats };
}
