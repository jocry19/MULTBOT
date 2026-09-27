import {
  describeCondition,
  strategySpecSchema,
  type StrategySpec,
  type StrategyStatus,
} from "@multbot/shared";
import { sha256Hex, stableStringify } from "../../core/hash.js";
import { PermanentError } from "../../core/errors.js";
import type { Database, Queryable } from "../../db/database.js";

/**
 * Strategy registry: strategies, immutable versions, status machine with full history.
 *
 * Money safety: the transition to LIVE_ENABLED can only be performed with actor "user".
 * The system may recommend a strategy for review, but never enables real trading itself.
 */

export type Actor = "system" | "user";

const TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  DISCOVERED: ["TESTING", "REJECTED", "PAUSED"],
  TESTING: ["PAPER_TRADING", "REJECTED", "PAUSED"],
  PAPER_TRADING: ["PAPER_VALIDATED", "DEGRADED", "REJECTED", "PAUSED"],
  PAPER_VALIDATED: ["LIVE_ENABLED", "DEGRADED", "PAUSED", "PAPER_TRADING", "REJECTED"],
  LIVE_ENABLED: ["DEGRADED", "PAUSED", "PAPER_VALIDATED"],
  DEGRADED: ["PAPER_TRADING", "PAPER_VALIDATED", "REJECTED", "PAUSED"],
  PAUSED: ["PAPER_TRADING", "PAPER_VALIDATED", "TESTING", "REJECTED"],
  REJECTED: ["TESTING"],
};

/** Transitions only a user may perform. */
const USER_ONLY: StrategyStatus[] = ["LIVE_ENABLED"];

export function canTransition(from: StrategyStatus, to: StrategyStatus, actor: Actor): boolean {
  if (USER_ONLY.includes(to) && actor !== "user") return false;
  if (from === "REJECTED" && actor !== "user") return false;
  return TRANSITIONS[from].includes(to);
}

export type StrategyRow = {
  id: string;
  name: string;
  family: string;
  origin: string;
  parent_strategy_id: string | null;
  status: StrategyStatus;
  status_reason: string | null;
  current_version_id: string | null;
  live_enabled: boolean;
  live_enabled_at: Date | null;
  paper_enabled: boolean;
  discovery_run_id: number | null;
  created_at: Date;
  updated_at: Date;
};

export type VersionRow = {
  id: string;
  strategy_id: string;
  version: string;
  major: number;
  minor: number;
  spec: StrategySpec;
  spec_hash: string;
  parent_version_id: string | null;
  change_summary: string | null;
  status: StrategyStatus;
  created_at: Date;
  challenger_since: Date | null;
  challenger_outcome: string | null;
  challenger_reason: string | null;
};

export function specHash(spec: StrategySpec): string {
  return sha256Hex(stableStringify(spec)).slice(0, 24);
}

export function autoName(spec: StrategySpec): string {
  const parts = spec.conditions.slice(0, 3).map((c) => {
    if (c.kind === "feature") return c.feature.replace(/__ctx[zp]ct?|__ctxz/, "").replace(/^d_(\w+?)__/, "$1:").replace(/_/g, " ");
    if (c.kind === "event") return c.eventType.replace(/_/g, " ");
    return `${c.dimension} regime`;
  });
  const h = spec.horizonSec >= 60 ? `${Math.round(spec.horizonSec / 60)}m` : `${spec.horizonSec}s`;
  return `${parts.join(" + ")} (${h})`;
}

export class StrategyService {
  private readonly listeners = new Set<(id: string, status: StrategyStatus) => void>();

  constructor(private readonly db: Database) {}

  onStatusChange(fn: (id: string, status: StrategyStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(id: string): Promise<StrategyRow | null> {
    return this.db.one<StrategyRow>("SELECT * FROM strategies WHERE id = $1", [id]);
  }

  async version(id: string): Promise<VersionRow | null> {
    return this.db.one<VersionRow>("SELECT * FROM strategy_versions WHERE id = $1", [id]);
  }

  async versions(strategyId: string): Promise<VersionRow[]> {
    return this.db.many<VersionRow>("SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY major, minor", [strategyId]);
  }

  async list(statuses?: StrategyStatus[]): Promise<StrategyRow[]> {
    if (statuses && statuses.length > 0) {
      return this.db.many<StrategyRow>("SELECT * FROM strategies WHERE status = ANY($1) ORDER BY seq", [statuses]);
    }
    return this.db.many<StrategyRow>("SELECT * FROM strategies ORDER BY seq");
  }

  /** Strategies (with current version) that should receive paper decision points. */
  async activeForPaper(): Promise<{ strategy: StrategyRow; version: VersionRow }[]> {
    const rows = await this.db.many<StrategyRow & { v: VersionRow }>(
      `SELECT s.*, row_to_json(v.*) AS v FROM strategies s JOIN strategy_versions v ON v.id = s.current_version_id
        WHERE s.paper_enabled AND s.status IN ('PAPER_TRADING', 'PAPER_VALIDATED', 'LIVE_ENABLED', 'DEGRADED')
       UNION ALL
       SELECT s.*, row_to_json(v.*) AS v FROM strategies s JOIN strategy_versions v ON v.strategy_id = s.id
        WHERE v.challenger_since IS NOT NULL AND v.status = 'PAPER_TRADING' AND v.id <> s.current_version_id
          AND s.paper_enabled AND s.status IN ('PAPER_TRADING', 'PAPER_VALIDATED', 'LIVE_ENABLED', 'DEGRADED')`,
    );
    return rows.map((r) => ({ strategy: r, version: r.v }));
  }

  /** Strategies the user enabled for live trading. */
  async activeForLive(): Promise<{ strategy: StrategyRow; version: VersionRow }[]> {
    const rows = await this.db.many<StrategyRow & { v: VersionRow }>(
      `SELECT s.*, row_to_json(v.*) AS v FROM strategies s JOIN strategy_versions v ON v.id = s.current_version_id
        WHERE s.live_enabled AND s.status = 'LIVE_ENABLED'`,
    );
    return rows.map((r) => ({ strategy: r, version: r.v }));
  }

  /**
   * Create a strategy (or a new version of an equivalent one) from a spec.
   * Returns null if an identical spec already exists.
   */
  async create(opts: {
    spec: StrategySpec;
    origin: "discovered" | "evolved" | "manual";
    name?: string;
    discoveryRunId?: number | null;
    parentStrategyId?: string | null;
    changeSummary?: string;
    evidence?: Record<string, unknown>;
  }): Promise<{ strategyId: string; versionId: string; created: "strategy" | "version" } | null> {
    const spec = strategySpecSchema.parse(opts.spec);
    const hash = specHash(spec);
    const existing = await this.db.one<{ id: string }>("SELECT id FROM strategy_versions WHERE spec_hash = $1", [hash]);
    if (existing) return null;

    // same feature set + same exit structure → new version of the existing strategy (evolution)
    const signature = featureSignature(spec);
    const similar = await this.db.many<{ strategy_id: string; spec: StrategySpec; id: string; major: number; minor: number }>(
      `SELECT v.strategy_id, v.spec, v.id, v.major, v.minor FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id
        WHERE s.family = $1 AND s.status <> 'REJECTED' ORDER BY v.major DESC, v.minor DESC`,
      [spec.family],
    );
    const parent = similar.find((v) => featureSignature(v.spec) === signature);

    return this.db.tx(async (c) => {
      if (parent && opts.origin !== "manual") {
        const minor = Math.max(...similar.filter((v) => v.strategy_id === parent.strategy_id).map((v) => v.minor)) + 1;
        const versionId = `${parent.strategy_id}@${parent.major}.${minor}`;
        await c.query(
          `INSERT INTO strategy_versions (id, strategy_id, version, major, minor, spec, spec_hash, parent_version_id, change_summary, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DISCOVERED')`,
          [versionId, parent.strategy_id, `${parent.major}.${minor}`, parent.major, minor, JSON.stringify(spec), hash, parent.id, opts.changeSummary ?? "re-discovered with different thresholds"],
        );
        if (opts.evidence) await this.addResult(c, versionId, "discovery", opts.evidence);
        return { strategyId: parent.strategy_id, versionId, created: "version" as const };
      }
      const seq = await c.query<{ n: number }>("SELECT nextval(pg_get_serial_sequence('strategies', 'seq'))::int8 AS n");
      const n = seq.rows[0]?.n ?? 0;
      const strategyId = `S-${String(n).padStart(6, "0")}`;
      const versionId = `${strategyId}@1.0`;
      await c.query(
        `INSERT INTO strategies (id, seq, name, family, origin, parent_strategy_id, status, current_version_id, discovery_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'DISCOVERED', $7, $8)`,
        [strategyId, n, (opts.name ?? autoName(spec)).slice(0, 200), spec.family, opts.origin, opts.parentStrategyId ?? null, versionId, opts.discoveryRunId ?? null],
      );
      await c.query(
        `INSERT INTO strategy_versions (id, strategy_id, version, major, minor, spec, spec_hash, change_summary, status)
         VALUES ($1, $2, '1.0', 1, 0, $3, $4, $5, 'DISCOVERED')`,
        [versionId, strategyId, JSON.stringify(spec), hash, opts.changeSummary ?? "initial version"],
      );
      await c.query(
        "INSERT INTO strategy_status_history (strategy_id, version_id, from_status, to_status, reason, actor) VALUES ($1, $2, NULL, 'DISCOVERED', $3, 'system')",
        [strategyId, versionId, opts.origin],
      );
      if (opts.evidence) await this.addResult(c, versionId, "discovery", opts.evidence);
      return { strategyId, versionId, created: "strategy" as const };
    });
  }

  async addResult(
    c: Queryable,
    versionId: string,
    kind: string,
    metrics: Record<string, unknown>,
    period?: { from: Date; to: Date },
  ): Promise<void> {
    await c.query(
      "INSERT INTO strategy_results (strategy_version_id, kind, period_start, period_end, metrics) VALUES ($1, $2, $3, $4, $5)",
      [versionId, kind, period?.from ?? null, period?.to ?? null, JSON.stringify(metrics)],
    );
  }

  async latestResult(versionId: string, kind: string): Promise<Record<string, unknown> | null> {
    const r = await this.db.one<{ metrics: Record<string, unknown> }>(
      "SELECT metrics FROM strategy_results WHERE strategy_version_id = $1 AND kind = $2 ORDER BY computed_at DESC, id DESC LIMIT 1",
      [versionId, kind],
    );
    return r?.metrics ?? null;
  }

  /** Status transition with validation and history. Throws on forbidden transitions. */
  async transition(id: string, to: StrategyStatus, reason: string, actor: Actor, evidence?: Record<string, unknown>): Promise<StrategyRow> {
    const s = await this.get(id);
    if (!s) throw new PermanentError("STRATEGY_NOT_FOUND", `strategy ${id} not found`);
    if (s.status === to) return s;
    if (!canTransition(s.status, to, actor)) {
      throw new PermanentError("STRATEGY_TRANSITION", `transition ${s.status} → ${to} not allowed for ${actor}`);
    }
    const liveEnabled = to === "LIVE_ENABLED" ? true : s.status === "LIVE_ENABLED" ? false : s.live_enabled;
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE strategies SET status = $2, status_reason = $3, live_enabled = $4,
           live_enabled_at = CASE WHEN $4 AND NOT live_enabled THEN now() ELSE live_enabled_at END WHERE id = $1`,
        [id, to, reason, liveEnabled],
      );
      if (s.current_version_id) await c.query("UPDATE strategy_versions SET status = $2 WHERE id = $1", [s.current_version_id, to]);
      await c.query(
        "INSERT INTO strategy_status_history (strategy_id, version_id, from_status, to_status, reason, actor, evidence) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, s.current_version_id, s.status, to, reason, actor, evidence ? JSON.stringify(evidence) : null],
      );
    });
    for (const l of this.listeners) l(id, to);
    return (await this.get(id)) as StrategyRow;
  }

  async setPaperEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.query("UPDATE strategies SET paper_enabled = $2 WHERE id = $1", [id, enabled]);
  }

  /**
   * Point the strategy at another version (evolution). Old versions stay untouched (immutable specs).
   * The system may only do this for strategies that are not live-enabled — changing what trades real
   * money is a user decision.
   */
  async setCurrentVersion(id: string, versionId: string, actor: Actor, reason = "current version changed"): Promise<void> {
    const v = await this.version(versionId);
    if (!v || v.strategy_id !== id) throw new PermanentError("VERSION", "version does not belong to strategy");
    const s = await this.get(id);
    if (!s) throw new PermanentError("STRATEGY_NOT_FOUND", `strategy ${id} not found`);
    if (actor !== "user" && s.status === "LIVE_ENABLED") {
      throw new PermanentError("STRATEGY_LIVE", "the version of a live-enabled strategy can only be changed by the user");
    }
    await this.db.tx(async (c) => {
      if (s.current_version_id && s.current_version_id !== versionId) {
        await c.query("UPDATE strategy_versions SET status = 'PAUSED' WHERE id = $1", [s.current_version_id]);
      }
      await c.query("UPDATE strategies SET current_version_id = $2 WHERE id = $1", [id, versionId]);
      await c.query(
        `UPDATE strategy_versions SET status = $2, challenger_since = NULL,
           challenger_outcome = CASE WHEN challenger_since IS NOT NULL THEN 'promoted' ELSE challenger_outcome END WHERE id = $1`,
        [versionId, s.status],
      );
      await c.query(
        "INSERT INTO strategy_status_history (strategy_id, version_id, from_status, to_status, reason, actor) VALUES ($1, $2, $3, $3, $4, $5)",
        [id, versionId, s.status, reason, actor],
      );
    });
    for (const l of this.listeners) l(id, s.status);
  }

  /**
   * Register an evolved variant as a challenger version (1.x → 1.x+1 for parameter changes,
   * x.y → x+1.0 for structural changes). Returns null if an identical spec already exists.
   */
  async createChallenger(opts: {
    strategyId: string;
    parentVersionId: string;
    spec: StrategySpec;
    bump: "minor" | "major";
    changeSummary: string;
    evidence: Record<string, unknown>;
  }): Promise<{ versionId: string; version: string } | null> {
    const spec = strategySpecSchema.parse(opts.spec);
    const hash = specHash(spec);
    if (await this.db.one("SELECT 1 FROM strategy_versions WHERE spec_hash = $1", [hash])) return null;
    const parent = await this.version(opts.parentVersionId);
    if (!parent || parent.strategy_id !== opts.strategyId) throw new PermanentError("VERSION", "parent version does not belong to strategy");
    return this.db.tx(async (c) => {
      const agg = await c.query<{ major: number; minor: number }>(
        "SELECT max(major)::int AS major, COALESCE(max(minor) FILTER (WHERE major = $2), 0)::int AS minor FROM strategy_versions WHERE strategy_id = $1",
        [opts.strategyId, parent.major],
      );
      const maxMajor = agg.rows[0]?.major ?? parent.major;
      const [major, minor] = opts.bump === "major" ? [maxMajor + 1, 0] : [parent.major, (agg.rows[0]?.minor ?? parent.minor) + 1];
      const version = `${major}.${minor}`;
      const versionId = `${opts.strategyId}@${version}`;
      await c.query(
        `INSERT INTO strategy_versions (id, strategy_id, version, major, minor, spec, spec_hash, parent_version_id, change_summary, status, challenger_since)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'TESTING', now())`,
        [versionId, opts.strategyId, version, major, minor, JSON.stringify(spec), hash, parent.id, opts.changeSummary.slice(0, 500)],
      );
      await this.addResult(c, versionId, "evolution", opts.evidence);
      return { versionId, version };
    });
  }

  /** Versions currently running (or queued) as challengers. */
  async challengers(status?: StrategyStatus): Promise<(VersionRow & { strategy_status: StrategyStatus; current_version_id: string | null })[]> {
    return this.db.many(
      `SELECT v.*, s.status AS strategy_status, s.current_version_id FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id
        WHERE v.challenger_since IS NOT NULL ${status ? "AND v.status = $1" : ""} ORDER BY v.challenger_since`,
      status ? [status] : [],
    );
  }

  /** Update a challenger's state; `outcome` ends the challenge (retired / recommended keeps it running). */
  async updateChallenger(versionId: string, patch: { status?: StrategyStatus; outcome?: "retired" | "recommended"; reason?: string }): Promise<void> {
    const end = patch.outcome === "retired";
    await this.db.query(
      `UPDATE strategy_versions SET status = COALESCE($2, status), challenger_outcome = COALESCE($3, challenger_outcome),
         challenger_reason = COALESCE($4, challenger_reason), challenger_since = CASE WHEN $5 THEN NULL ELSE challenger_since END WHERE id = $1`,
      [versionId, patch.status ?? null, patch.outcome ?? null, patch.reason ?? null, end],
    );
    for (const l of this.listeners) l(versionId.split("@")[0] as string, (patch.status ?? "PAPER_TRADING") as StrategyStatus);
  }

  async history(id: string): Promise<Record<string, unknown>[]> {
    return this.db.many("SELECT * FROM strategy_status_history WHERE strategy_id = $1 ORDER BY ts DESC", [id]);
  }
}

/** Features + exit structure, ignoring threshold values. */
export function featureSignature(spec: StrategySpec): string {
  const conds = spec.conditions
    .map((c) => (c.kind === "feature" ? `f:${c.feature}:${c.op}` : c.kind === "event" ? `e:${c.eventType}` : `r:${c.dimension}`))
    .sort()
    .join(",");
  const exit = `${spec.horizonSec}:${spec.exit.takeProfitPct !== undefined}:${spec.exit.stopLossPct !== undefined}`;
  return `${spec.family}|${conds}|${exit}|${spec.universe.venues.slice().sort().join(",")}`;
}

export function describeSpec(spec: StrategySpec): string[] {
  return spec.conditions.map(describeCondition);
}
