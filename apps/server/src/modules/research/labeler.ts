import type { Settings } from "@multbot/shared";
import type { Logger } from "pino";
import type { Clock } from "../../core/clock.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import { DEFAULT_EXECUTION, HistoricalMarketView, type ExecutionParams } from "../execution/simulator.js";
import { computeOutcome, OUTCOME_HORIZONS_SEC, PATH_OFFSETS_SEC } from "./outcomes.js";
import { loadGaps, loadStateTrades, overlapsGap } from "./tradeLoader.js";

const MAX_HORIZON_MS = Math.max(...OUTCOME_HORIZONS_SEC) * 1000;
/** Data younger than this is not considered complete yet (ingest + write latency). */
const DATA_SAFETY_MS = 60_000;

export function executionParamsFromSettings(s: Settings): ExecutionParams {
  return {
    ...DEFAULT_EXECUTION,
    executionDelayMs: s.research.executionDelayMs,
    failedTxRate: s.research.failedTxRate,
    priorityFeeSol: s.research.assumedPriorityFeeSol,
    mevImpactBps: s.research.mevImpactBps,
  };
}

/**
 * Labels research samples and events with their realistic forward outcomes once the horizons have
 * elapsed. Labels are computed from persisted trades only (strictly after the decision time).
 */
export class OutcomeLabeler extends BaseModule {
  labeled = 0;
  eventsLabeled = 0;

  constructor(
    private readonly db: Database,
    private readonly settings: () => Settings,
    private readonly clock: Clock,
    log: Logger,
    private readonly batchSize = 4000,
  ) {
    super("labeler", log);
    this.every("samples", 60_000, () => this.labelSamples().then(() => undefined));
    this.every("events", 120_000, () => this.labelEvents().then(() => undefined));
    this.every("long-path", 15 * 60_000, () => this.labelLongPaths().then(() => undefined));
  }

  override healthDetail(): string {
    return `labeled=${this.labeled} events=${this.eventsLabeled}`;
  }

  /** Label samples whose longest horizon has elapsed. Returns the number labelled. */
  async labelSamples(now = this.clock.now()): Promise<number> {
    const s = this.settings();
    const exec = executionParamsFromSettings(s);
    const dataUntil = now - DATA_SAFETY_MS;
    const cutoff = new Date(dataUntil - MAX_HORIZON_MS - exec.executionDelayMs * 2);
    const rows = await this.db.many<{ id: number; mint: string; ts: Date }>(
      `SELECT id, mint, ts FROM research_samples WHERE labeled_at IS NULL AND ts <= $1 ORDER BY ts LIMIT $2`,
      [cutoff, this.batchSize],
    );
    if (rows.length === 0) return 0;
    const from = new Date(Math.min(...rows.map((r) => r.ts.getTime())) - 3_600_000);
    const to = new Date(Math.max(...rows.map((r) => r.ts.getTime())) + MAX_HORIZON_MS + 10 * 60_000);
    const gaps = await loadGaps(this.db, from, to);
    const byMint = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byMint.get(r.mint) ?? [];
      arr.push(r);
      byMint.set(r.mint, arr);
    }
    const updates: [number, Date, string][] = [];
    const mints = [...byMint.keys()];
    for (let i = 0; i < mints.length; i += 200) {
      const chunk = mints.slice(i, i + 200);
      const trades = await loadStateTrades(this.db, chunk, from, to);
      const view = new HistoricalMarketView();
      for (const [mint, arr] of trades) view.set(mint, arr);
      for (const mint of chunk) {
        for (const r of byMint.get(mint) ?? []) {
          const outcome = computeOutcome(view, mint, r.ts.getTime(), {
            positionSol: s.trading.positionSizeSol,
            exec,
            dataUntil,
            isGap: (a, b) => overlapsGap(gaps, a, b),
          });
          updates.push([r.id, r.ts, JSON.stringify(outcome)]);
        }
      }
    }
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const params: unknown[] = [];
      const values = chunk.map(([id, ts, o]) => {
        params.push(id, ts, o);
        const b = params.length - 3;
        return `($${b + 1}::bigint, $${b + 2}::timestamptz, $${b + 3}::jsonb)`;
      });
      await this.db.query(
        `UPDATE research_samples s SET outcome = v.o, labeled_at = now()
           FROM (VALUES ${values.join(",")}) AS v(id, ts, o) WHERE s.id = v.id AND s.ts = v.ts`,
        params,
      );
    }
    this.labeled += updates.length;
    this.log.debug({ labeled: updates.length }, "research samples labelled");
    return updates.length;
  }

  /** Fill in the 6h/24h path prices once they are available. */
  async labelLongPaths(now = this.clock.now()): Promise<number> {
    const dataUntil = now - DATA_SAFETY_MS;
    const longest = Math.max(...PATH_OFFSETS_SEC);
    const rows = await this.db.many<{ id: number; mint: string; ts: Date; outcome: { path: Record<string, number | null> } }>(
      `SELECT id, mint, ts, outcome FROM research_samples
        WHERE labeled_at IS NOT NULL AND ts <= $1 AND (outcome->'path'->>'${longest}') IS NULL
          AND (outcome->'entry'->>'ok')::boolean
        ORDER BY ts LIMIT $2`,
      [new Date(dataUntil - longest * 1000), this.batchSize],
    );
    if (rows.length === 0) return 0;
    const mints = [...new Set(rows.map((r) => r.mint))];
    let n = 0;
    for (let i = 0; i < mints.length; i += 200) {
      const chunk = mints.slice(i, i + 200);
      const chunkRows = rows.filter((r) => chunk.includes(r.mint));
      const from = new Date(Math.min(...chunkRows.map((r) => r.ts.getTime())));
      const to = new Date(Math.max(...chunkRows.map((r) => r.ts.getTime())) + longest * 1000);
      const view = new HistoricalMarketView();
      for (const [m, arr] of await loadStateTrades(this.db, chunk, from, to)) view.set(m, arr);
      for (const r of chunkRows) {
        const path = { ...r.outcome.path };
        for (const off of PATH_OFFSETS_SEC) path[String(off)] = view.stateAt(r.mint, r.ts.getTime() + off * 1000)?.priceSol ?? null;
        await this.db.query(
          "UPDATE research_samples SET outcome = jsonb_set(outcome, '{path}', $1::jsonb) WHERE id = $2 AND ts = $3",
          [JSON.stringify(path), r.id, r.ts],
        );
        n++;
      }
    }
    return n;
  }

  /** Price path after each event (what happened afterwards). */
  async labelEvents(now = this.clock.now()): Promise<number> {
    const dataUntil = now - DATA_SAFETY_MS;
    const rows = await this.db.many<{ id: number; mint: string | null; ts: Date }>(
      `SELECT id, mint, ts FROM events WHERE NOT outcome_complete AND ts <= $1 ORDER BY ts LIMIT $2`,
      [new Date(dataUntil - 3_600_000), this.batchSize],
    );
    if (rows.length === 0) return 0;
    const mints = [...new Set(rows.map((r) => r.mint).filter((m): m is string => m !== null))];
    const from = new Date(Math.min(...rows.map((r) => r.ts.getTime())) - 60_000);
    const to = new Date(Math.max(...rows.map((r) => r.ts.getTime())) + 3_600_000);
    const view = new HistoricalMarketView();
    for (let i = 0; i < mints.length; i += 200) {
      for (const [m, arr] of await loadStateTrades(this.db, mints.slice(i, i + 200), from, to)) view.set(m, arr);
    }
    const offsets = [1, 5, 10, 30, 60, 300, 900, 1800, 3600];
    for (const r of rows) {
      let outcome: Record<string, unknown> | null = null;
      if (r.mint) {
        const t0 = r.ts.getTime();
        const p0 = view.stateAt(r.mint, t0)?.priceSol ?? null;
        const path: Record<string, number | null> = {};
        const ret: Record<string, number | null> = {};
        for (const off of offsets) {
          const p = view.stateAt(r.mint, t0 + off * 1000)?.priceSol ?? null;
          path[String(off)] = p;
          ret[String(off)] = p !== null && p0 ? p / p0 - 1 : null;
        }
        let hi = p0 ?? 0;
        let lo = p0 ?? 0;
        for (const t of view.tradesOf(r.mint)) {
          if (t.ts <= t0 || t.ts > t0 + 3_600_000) continue;
          hi = Math.max(hi, t.priceSol);
          lo = Math.min(lo, t.priceSol);
        }
        outcome = { p0, path, ret, maxRunup1h: p0 ? hi / p0 - 1 : null, maxDrawdown1h: p0 ? lo / p0 - 1 : null };
      }
      await this.db.query("UPDATE events SET outcome = $1, outcome_complete = true WHERE id = $2", [
        outcome === null ? null : JSON.stringify(outcome),
        r.id,
      ]);
    }
    this.eventsLabeled += rows.length;
    return rows.length;
  }
}
