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
  return `d_${op}__${args.join("__")}`;
}

export function parseDerivedName(name: string): DerivedFeatureDef | null {
  if (!name.startsWith("d_")) return null;
  const [opPart, ...args] = name.slice(2).split("__");
  if (!opPart || args.length < 2) return null;
  if (!["ratio", "product", "diff", "ratio3"].includes(opPart)) return null;
  return { name, op: opPart as DerivedOp, args };
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
