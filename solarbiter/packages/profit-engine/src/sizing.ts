import { eurToLamports, lamportsToEur, type CostBreakdown, type SizeEvaluation } from "@solarbiter/shared";

/** A firm round-trip result at one size: SOL in → SOL out. */
export interface RoundTripPoint {
  inputLamports: bigint;
  outputLamports: bigint;
}

/**
 * Linear impact model of the round-trip return r(x) = out/in = r0 − c·x.
 *   r0  return for an infinitesimal trade (mid spread after pool fees)
 *   c   impact per lamport (≥ 0)
 * Fitted from firm quotes: with one point, r0 comes from the mid spread; with two or more points
 * both parameters are fitted by least squares.
 */
export interface ImpactModel {
  r0: number;
  c: number;
  points: number;
}

export function fitImpactModel(points: RoundTripPoint[], midReturnAfterFees: number): ImpactModel {
  const pts = points.filter((p) => p.inputLamports > 0n).map((p) => ({ x: Number(p.inputLamports), r: Number(p.outputLamports) / Number(p.inputLamports) }));
  if (pts.length === 0) return { r0: midReturnAfterFees, c: 0, points: 0 };
  if (pts.length === 1) {
    const p = pts[0] as { x: number; r: number };
    // the quote cannot be better than the mid after fees + a small tolerance for pool drift
    const r0 = Math.max(midReturnAfterFees, p.r);
    return { r0, c: Math.max(0, (r0 - p.r) / p.x), points: 1 };
  }
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const mr = pts.reduce((a, p) => a + p.r, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxr = pts.reduce((a, p) => a + (p.x - mx) * (p.r - mr), 0);
  let c = sxx > 0 ? -sxr / sxx : 0;
  if (!(c >= 0)) c = 0; // impact never improves the price with size
  return { r0: mr + c * mx, c, points: n };
}

export function predictOutput(m: ImpactModel, inputLamports: bigint): bigint {
  const x = Number(inputLamports);
  const r = Math.max(0, m.r0 - m.c * x);
  return BigInt(Math.floor(x * r));
}

/**
 * Evaluate every ladder size. Sizes with a firm quote use it; the others use the fitted impact
 * model (marked `interpolated` — the chosen size is always re-quoted firm before any decision).
 */
export function evaluateLadder(
  sizesEur: number[],
  solEur: number,
  model: ImpactModel,
  firm: RoundTripPoint[],
  costs: (inputLamports: bigint, outputLamports: bigint) => CostBreakdown,
): SizeEvaluation[] {
  const byInput = new Map(firm.map((p) => [p.inputLamports, p.outputLamports]));
  return sizesEur.map((sizeEur) => {
    const inputLamports = eurToLamports(sizeEur, solEur);
    const firmOut = byInput.get(inputLamports);
    const outputLamports = firmOut ?? predictOutput(model, inputLamports);
    const c = costs(inputLamports, outputLamports);
    return { sizeEur, inputLamports, outputLamports, costs: c, netEur: lamportsToEur(c.usableEdgeLamports, solEur), interpolated: firmOut === undefined };
  });
}

/** The size with the highest expected net profit; null if no size has a positive usable edge. */
export function chooseOptimalSize(evals: SizeEvaluation[]): SizeEvaluation | null {
  let best: SizeEvaluation | null = null;
  for (const e of evals) {
    if (e.costs.usableEdgeLamports <= 0n) continue;
    if (!best || e.costs.usableEdgeLamports > best.costs.usableEdgeLamports) best = e;
  }
  return best;
}
