import type { FeatureVector } from "./types.js";

/**
 * Derived (combination) features. The discovery engine proposes combinations of base features;
 * surviving combinations are registered so live evaluation can compute exactly the same values.
 */

export type DerivedOp = "ratio" | "product" | "diff" | "ratio3";

export interface DerivedFeatureDef {
  name: string;
  op: DerivedOp;
  args: string[];
}

const EPS = 1e-9;

export function derivedName(op: DerivedOp, args: string[]): string {
  return `d:${op}(${args.join(",")})`;
}

const DERIVED_RE = /^d:(ratio|product|diff|ratio3)\(([^()]+)\)$/;

export function isDerivedName(name: string): boolean {
  return name.startsWith("d:");
}

export function parseDerivedName(name: string): DerivedFeatureDef | null {
  const m = DERIVED_RE.exec(name);
  if (!m) return null;
  const args = (m[2] as string).split(",");
  if (args.length < 2 || args.some((a) => a.length === 0 || a.startsWith("d:"))) return null;
  return { name, op: m[1] as DerivedOp, args };
}

export function evalDerived(def: DerivedFeatureDef, f: FeatureVector): number | undefined {
  const vals = def.args.map((a) => f[a]);
  if (vals.some((v) => v === undefined || !Number.isFinite(v))) return undefined;
  const [a, b, c] = vals as number[];
  let out: number;
  switch (def.op) {
    case "ratio":
      out = (a as number) / (Math.abs(b as number) + EPS);
      break;
    case "product":
      out = (a as number) * (b as number);
      break;
    case "diff":
      out = (a as number) - (b as number);
      break;
    case "ratio3":
      out = (a as number) / (Math.abs(b as number) + EPS) / (Math.abs(c ?? 1) + EPS);
      break;
  }
  return Number.isFinite(out) ? out : undefined;
}

/** Adds all derived features to `f` (in place). Unknown/missing inputs are skipped. */
export function applyDerived(defs: Iterable<DerivedFeatureDef>, f: FeatureVector): FeatureVector {
  for (const d of defs) {
    const v = evalDerived(d, f);
    if (v !== undefined) f[d.name] = v;
  }
  return f;
}
