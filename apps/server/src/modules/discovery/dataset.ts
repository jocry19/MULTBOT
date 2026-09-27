import type { Database } from "../../db/database.js";
import type { SampleOutcome } from "../research/outcomes.js";
import { TP_LEVELS, SL_LEVELS, TPSL_HORIZONS_SEC, OUTCOME_HORIZONS_SEC, tpslKey } from "../research/outcomes.js";

/**
 * Columnar research dataset: labelled decision points (features known at decision time) and their
 * realistic forward outcomes (targets). Missing values are NaN. Rows are sorted by time.
 */

export interface DatasetRow {
  id: number;
  ts: number;
  mint: string;
  venue: string;
  ageSec: number;
  trigger: string;
  regimeLabel: string | null;
  features: Record<string, number>;
  outcome: SampleOutcome;
}

/** Target names: "h:<sec>" (fixed horizon exit) and "tpsl:<H>:<tp>:<sl>". */
export function allTargets(): string[] {
  const t: string[] = OUTCOME_HORIZONS_SEC.map((h) => `h:${h}`);
  for (const h of TPSL_HORIZONS_SEC) for (const tp of TP_LEVELS) for (const sl of SL_LEVELS) t.push(`tpsl:${tpslKey(h, tp, sl)}`);
  return t;
}

export function targetHorizonSec(target: string): number {
  const parts = target.split(":");
  return Number(parts[1]);
}

export class Dataset {
  readonly n: number;
  readonly ids: Float64Array;
  readonly ts: Float64Array;
  /** Token age at the decision point (seconds). */
  readonly ageSec: Float64Array;
  readonly mintIdx: Int32Array;
  readonly mints: string[];
  readonly venues: string[];
  readonly regimes: (string | null)[];
  readonly triggers: string[];
  readonly features = new Map<string, Float32Array>();
  readonly targets = new Map<string, Float32Array>();
  /** Per target: expected gross return (net + costs) for cost analysis. */
  readonly grossTargets = new Map<string, Float32Array>();

  constructor(rows: DatasetRow[], featureNames?: string[], targetNames: string[] = allTargets()) {
    rows.sort((a, b) => a.ts - b.ts);
    this.n = rows.length;
    this.ids = new Float64Array(this.n);
    this.ts = new Float64Array(this.n);
    this.ageSec = new Float64Array(this.n);
    this.mintIdx = new Int32Array(this.n);
    this.mints = [];
    this.venues = [];
    this.regimes = [];
    this.triggers = [];
    const mintMap = new Map<string, number>();
    const names = featureNames ?? collectFeatureNames(rows);
    for (const f of names) this.features.set(f, new Float32Array(this.n).fill(Number.NaN));
    for (const t of targetNames) {
      this.targets.set(t, new Float32Array(this.n).fill(Number.NaN));
      if (t.startsWith("h:")) this.grossTargets.set(t, new Float32Array(this.n).fill(Number.NaN));
    }
    rows.forEach((r, i) => {
      this.ids[i] = r.id;
      this.ts[i] = r.ts;
      this.ageSec[i] = r.ageSec;
      let mi = mintMap.get(r.mint);
      if (mi === undefined) {
        mi = this.mints.length;
        mintMap.set(r.mint, mi);
        this.mints.push(r.mint);
      }
      this.mintIdx[i] = mi;
      this.venues.push(r.venue);
      this.regimes.push(r.regimeLabel);
      this.triggers.push(r.trigger);
      for (const [f, col] of this.features) {
        const v = r.features[f];
        if (v !== undefined && Number.isFinite(v)) col[i] = v;
      }
      if (!r.outcome.entry.ok) return;
      for (const [t, col] of this.targets) {
        if (t.startsWith("h:")) {
          const h = r.outcome.horizons[t.slice(2)];
          if (h && !h.gap) {
            col[i] = h.ret;
            (this.grossTargets.get(t) as Float32Array)[i] = h.gross / r.outcome.positionSol;
          }
        } else {
          const v = r.outcome.tpsl[t.slice(5)];
          if (v !== undefined) col[i] = v;
        }
      }
    });
  }

  feature(name: string): Float32Array | undefined {
    return this.features.get(name);
  }

  target(name: string): Float32Array {
    const t = this.targets.get(name);
    if (!t) throw new Error(`unknown target ${name}`);
    return t;
  }

  /** Add a computed column (derived features). */
  addFeature(name: string, values: Float32Array): void {
    this.features.set(name, values);
  }

  get period(): { from: number; to: number } {
    return { from: this.n > 0 ? (this.ts[0] as number) : 0, to: this.n > 0 ? (this.ts[this.n - 1] as number) : 0 };
  }
}

function collectFeatureNames(rows: DatasetRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const k of Object.keys(r.features)) counts.set(k, (counts.get(k) ?? 0) + 1);
  // keep features present in at least 5% of rows; drop identifiers that must never be conditions
  const minCount = Math.max(1, Math.floor(rows.length * 0.05));
  const excluded = new Set(["price_sol", "coverage_sec", "seen_from_creation"]);
  return [...counts.entries()]
    .filter(([k, c]) => c >= minCount && !excluded.has(k))
    .map(([k]) => k)
    .sort();
}

export async function loadDataset(
  db: Database,
  opts: { from: Date; to: Date; maxRows: number },
): Promise<Dataset> {
  // uniform subsampling across the whole period (not just the most recent rows)
  const cnt = await db.one<{ n: number }>(
    `SELECT count(*)::int8 AS n FROM research_samples WHERE labeled_at IS NOT NULL AND ts >= $1 AND ts <= $2`,
    [opts.from, opts.to],
  );
  const step = Math.max(1, Math.ceil((cnt?.n ?? 0) / opts.maxRows));
  const rows = await db.many<{
    id: number;
    ts: Date;
    mint: string;
    venue: string;
    age_sec: number;
    trigger: string;
    regime: { label?: string } | null;
    features: Record<string, number>;
    outcome: SampleOutcome;
  }>(
    `SELECT id, ts, mint, venue, age_sec, trigger, regime, features, outcome
       FROM research_samples
      WHERE labeled_at IS NOT NULL AND ts >= $1 AND ts <= $2 AND (outcome->'entry'->>'ok')::boolean
        AND id % $4 = 0
      ORDER BY ts DESC LIMIT $3`,
    [opts.from, opts.to, opts.maxRows, step],
  );
  return new Dataset(
    rows.map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      mint: r.mint,
      venue: r.venue,
      ageSec: r.age_sec,
      trigger: r.trigger,
      regimeLabel: r.regime?.label ?? null,
      features: r.features,
      outcome: r.outcome,
    })),
  );
}
