import { idempotencyKey } from "../../core/hash.js";
import type { MarketEvent } from "../../domain/market.js";
import type { FeatureVector } from "../features/types.js";
import type { TokenState } from "../market/tokenState.js";

/**
 * Event detection. Detectors are transparent rules on (mostly context-relative) features; events
 * are data points for research, NOT trading signals. Besides the named detectors, a generic anomaly
 * detector emits an event for ANY contextual feature that becomes extreme, and co-occurring events
 * form combination events — so the event vocabulary grows with the feature set.
 */

export interface DetectedEvent {
  uid: string;
  type: string;
  mint: string | null;
  ts: number;
  availableAt: number;
  severity: number;
  direction: -1 | 0 | 1;
  detector: string;
  detectorVersion: number;
  context: Record<string, number>;
}

export interface DetectorResult {
  severity: number;
  direction: -1 | 0 | 1;
  context?: Record<string, number>;
}

export interface Detector {
  type: string;
  version: number;
  cooldownSec: number;
  detect(f: FeatureVector, t: TokenState, now: number): DetectorResult | null;
}

const v = (f: FeatureVector, k: string, d = 0) => f[k] ?? d;

const LIFECYCLE = new Set(["token_created", "curve_complete", "migration", "regime_shift"]);

function pick(f: FeatureVector, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) if (f[k] !== undefined) out[k] = Number((f[k] as number).toPrecision(6));
  return out;
}

export const DEFAULT_DETECTORS: Detector[] = [
  {
    type: "volume_spike",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "volume_60s__ctxz") >= 3 && v(f, "volume_accel_60s") >= 2 && v(f, "trades_60s") >= 5
        ? { severity: v(f, "volume_60s__ctxz"), direction: v(f, "net_flow_60s") >= 0 ? 1 : -1, context: pick(f, ["volume_60s", "volume_accel_60s", "net_flow_60s"]) }
        : null,
  },
  {
    type: "volume_dryup",
    version: 1,
    cooldownSec: 300,
    detect: (f) =>
      v(f, "trades_5m") >= 20 && v(f, "volume_accel_60s", 1) <= 0.15
        ? { severity: 1 / Math.max(0.01, v(f, "volume_accel_60s", 1)), direction: 0, context: pick(f, ["volume_5m", "volume_accel_60s"]) }
        : null,
  },
  {
    type: "buyer_surge",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "new_buyers_60s__ctxz") >= 3 && v(f, "new_buyers_60s") >= 5
        ? { severity: v(f, "new_buyers_60s__ctxz"), direction: 1, context: pick(f, ["new_buyers_60s", "buyer_accel"]) }
        : null,
  },
  {
    type: "seller_surge",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "unique_sellers_60s__ctxz") >= 3 && v(f, "net_flow_60s") < 0 && v(f, "unique_sellers_60s") >= 5
        ? { severity: v(f, "unique_sellers_60s__ctxz"), direction: -1, context: pick(f, ["unique_sellers_60s", "net_flow_60s"]) }
        : null,
  },
  {
    type: "whale_entry",
    version: 1,
    cooldownSec: 60,
    detect: (f) =>
      v(f, "max_buy_sol_60s__ctxz") >= 3 && v(f, "max_buy_sol_60s") >= 0.05 * Math.max(1, v(f, "liquidity_sol"))
        ? { severity: v(f, "max_buy_sol_60s__ctxz"), direction: 1, context: pick(f, ["max_buy_sol_60s", "liquidity_sol"]) }
        : null,
  },
  {
    type: "whale_exit",
    version: 1,
    cooldownSec: 60,
    detect: (f) =>
      v(f, "max_sell_sol_60s__ctxz") >= 3 && v(f, "max_sell_sol_60s") >= 0.05 * Math.max(1, v(f, "liquidity_sol"))
        ? { severity: v(f, "max_sell_sol_60s__ctxz"), direction: -1, context: pick(f, ["max_sell_sol_60s", "liquidity_sol"]) }
        : null,
  },
  {
    type: "creator_sell",
    version: 1,
    cooldownSec: 600,
    detect: (_f, t, now) =>
      t.creatorFirstSellAt !== null && now - t.creatorFirstSellAt <= 15_000
        ? { severity: Math.min(10, 1 + 10 * (t.creatorBoughtTokens > 0 ? t.creatorSoldTokens / t.creatorBoughtTokens : 1)), direction: -1 }
        : null,
  },
  {
    type: "price_breakout",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "ret_60s__ctxz") >= 3 && v(f, "ret_60s") > 0.05
        ? { severity: v(f, "ret_60s__ctxz"), direction: 1, context: pick(f, ["ret_60s", "volume_60s"]) }
        : null,
  },
  {
    type: "price_crash",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "ret_60s__ctxz") <= -3 && v(f, "ret_60s") < -0.05
        ? { severity: -v(f, "ret_60s__ctxz"), direction: -1, context: pick(f, ["ret_60s", "volume_60s"]) }
        : null,
  },
  {
    type: "price_reversal",
    version: 1,
    cooldownSec: 120,
    detect: (f) => {
      const prev = v(f, "ret_prev_30s");
      const cur = v(f, "ret_30s");
      if (Math.abs(prev) < 0.1 || Math.sign(prev) === Math.sign(cur) || Math.abs(cur) < 0.5 * Math.abs(prev)) return null;
      return { severity: Math.abs(cur - prev) * 10, direction: cur > 0 ? 1 : -1, context: pick(f, ["ret_prev_30s", "ret_30s"]) };
    },
  },
  {
    type: "holder_acceleration",
    version: 1,
    cooldownSec: 180,
    detect: (f) =>
      v(f, "holder_growth_60s__ctxz") >= 3 && v(f, "holder_growth_60s") >= 5
        ? { severity: v(f, "holder_growth_60s__ctxz"), direction: 1, context: pick(f, ["holder_growth_60s", "holders"]) }
        : null,
  },
  {
    type: "transaction_acceleration",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "trade_accel_30s") >= 3 && v(f, "trades_60s__ctxz") >= 2
        ? { severity: v(f, "trades_60s__ctxz"), direction: 0, context: pick(f, ["trade_accel_30s", "trades_60s"]) }
        : null,
  },
  {
    type: "volatility_expansion",
    version: 1,
    cooldownSec: 180,
    detect: (f) =>
      v(f, "vol_expansion") >= 2.5 && v(f, "volatility_60s__ctxz") >= 2
        ? { severity: v(f, "volatility_60s__ctxz"), direction: 0, context: pick(f, ["vol_expansion", "volatility_60s"]) }
        : null,
  },
  {
    type: "volatility_compression",
    version: 1,
    cooldownSec: 600,
    detect: (f) =>
      v(f, "vol_expansion", 1) <= 0.3 && v(f, "trades_5m") >= 20
        ? { severity: 1 / Math.max(0.05, v(f, "vol_expansion", 1)), direction: 0, context: pick(f, ["vol_expansion"]) }
        : null,
  },
  {
    type: "smart_money_entry",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "smart_buyers_60s") >= 2 || v(f, "smart_buy_sol_60s__ctxz") >= 3
        ? { severity: v(f, "smart_buyers_60s") + Math.max(0, v(f, "smart_buy_sol_60s__ctxz")), direction: 1, context: pick(f, ["smart_buyers_60s", "smart_buy_sol_60s"]) }
        : null,
  },
  {
    type: "smart_money_exit",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "smart_net_flow_60s") <= -0.5
        ? { severity: -v(f, "smart_net_flow_60s"), direction: -1, context: pick(f, ["smart_net_flow_60s"]) }
        : null,
  },
  {
    type: "coordinated_buying",
    version: 1,
    cooldownSec: 120,
    detect: (f) =>
      v(f, "max_buyers_same_slot_60s") >= 4 && v(f, "max_buyers_same_slot_60s__ctxz") >= 3
        ? { severity: v(f, "max_buyers_same_slot_60s__ctxz"), direction: 1, context: pick(f, ["max_buyers_same_slot_60s"]) }
        : null,
  },
  {
    type: "wallet_cluster_activity",
    version: 1,
    cooldownSec: 180,
    detect: (f) =>
      v(f, "cluster_max_share_60s") >= 0.5 && v(f, "buy_volume_60s") >= 0.5
        ? { severity: 10 * v(f, "cluster_max_share_60s"), direction: 1, context: pick(f, ["cluster_max_share_60s", "distinct_clusters_60s"]) }
        : null,
  },
  {
    type: "liquidity_drop",
    version: 1,
    cooldownSec: 300,
    detect: (f) =>
      v(f, "liq_withdraw_share_15m") >= 0.2
        ? { severity: 10 * v(f, "liq_withdraw_share_15m"), direction: -1, context: pick(f, ["liq_withdraw_share_15m", "liquidity_sol"]) }
        : null,
  },
  {
    type: "liquidity_add",
    version: 1,
    cooldownSec: 300,
    detect: (f) =>
      v(f, "liq_deposit_share_15m") >= 0.2
        ? { severity: 10 * v(f, "liq_deposit_share_15m"), direction: 1, context: pick(f, ["liq_deposit_share_15m", "liquidity_sol"]) }
        : null,
  },
  {
    type: "near_completion",
    version: 1,
    cooldownSec: 24 * 3600,
    detect: (f) =>
      v(f, "bonding_progress") >= 0.9 && v(f, "is_amm") === 0
        ? { severity: 10 * v(f, "bonding_progress"), direction: 1, context: pick(f, ["bonding_progress", "market_cap_sol"]) }
        : null,
  },
  {
    type: "price_volume_divergence",
    version: 1,
    cooldownSec: 300,
    detect: (f) => {
      const r = v(f, "ret_5m");
      const acc = v(f, "volume_accel_5m", 1);
      if (r > 0.2 && acc < 0.5) return { severity: r / Math.max(0.05, acc), direction: -1, context: pick(f, ["ret_5m", "volume_accel_5m"]) };
      if (r < -0.2 && acc > 2) return { severity: -r * acc, direction: 1, context: pick(f, ["ret_5m", "volume_accel_5m"]) };
      return null;
    },
  },
  {
    type: "liquidity_volume_divergence",
    version: 1,
    cooldownSec: 300,
    detect: (f) =>
      v(f, "volume_to_liq_5m__ctxz") >= 3
        ? { severity: v(f, "volume_to_liq_5m__ctxz"), direction: 0, context: pick(f, ["volume_to_liq_5m", "liquidity_sol"]) }
        : null,
  },
];

export interface EventEngineOptions {
  /** |ctxz| threshold for generic anomaly events. */
  genericZ?: number;
  genericCooldownSec?: number;
  /** Window in which two named events form a combination event. */
  comboWindowSec?: number;
  /** Latency added to `now` for availableAt of derived events (processing time). */
  processingDelayMs?: number;
}

export class EventEngine {
  private readonly lastFired = new Map<string, number>();
  /** mint → type → last event ts */
  private readonly lastByToken = new Map<string, Map<string, number>>();
  private readonly genericZ: number;
  private readonly genericCooldownSec: number;
  private readonly comboWindowSec: number;
  private readonly processingDelayMs: number;

  constructor(
    private readonly detectors: Detector[] = DEFAULT_DETECTORS,
    opts: EventEngineOptions = {},
  ) {
    this.genericZ = opts.genericZ ?? 5;
    this.genericCooldownSec = opts.genericCooldownSec ?? 300;
    this.comboWindowSec = opts.comboWindowSec ?? 30;
    this.processingDelayMs = opts.processingDelayMs ?? 0;
  }

  get detectorTypes(): string[] {
    return this.detectors.map((d) => d.type);
  }

  private fire(
    type: string,
    mint: string | null,
    now: number,
    cooldownSec: number,
    r: DetectorResult,
    detector: string,
    version: number,
    out: DetectedEvent[],
  ): boolean {
    const key = `${mint ?? "*"}|${type}`;
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < cooldownSec * 1000) return false;
    this.lastFired.set(key, now);
    if (mint) {
      let m = this.lastByToken.get(mint);
      if (!m) {
        m = new Map();
        this.lastByToken.set(mint, m);
      }
      m.set(type, now);
    }
    out.push({
      uid: idempotencyKey("event", type, mint, now),
      type,
      mint,
      ts: now,
      availableAt: now + this.processingDelayMs,
      severity: Number(r.severity.toFixed(4)),
      direction: r.direction,
      detector,
      detectorVersion: version,
      context: r.context ?? {},
    });
    return true;
  }

  /** Run all detectors for one token at `now` (features must already include ctx transforms). */
  process(t: TokenState, f: FeatureVector, now: number): DetectedEvent[] {
    const out: DetectedEvent[] = [];
    const named: string[] = [];
    for (const d of this.detectors) {
      let r: DetectorResult | null = null;
      try {
        r = d.detect(f, t, now);
      } catch {
        r = null;
      }
      if (r && Number.isFinite(r.severity)) {
        if (this.fire(d.type, t.mint, now, d.cooldownSec, r, d.type, d.version, out)) named.push(d.type);
      }
    }
    // generic contextual anomalies for every ctx feature
    for (const [k, z] of Object.entries(f)) {
      if (!k.endsWith("__ctxz") || Math.abs(z) < this.genericZ) continue;
      const feat = k.slice(0, -"__ctxz".length);
      const dir = z > 0 ? "up" : "down";
      this.fire(`anomaly:${feat}:${dir}`, t.mint, now, this.genericCooldownSec, { severity: Math.abs(z), direction: z > 0 ? 1 : -1, context: { [feat]: f[feat] ?? 0, z } }, "generic_anomaly", 1, out);
    }
    // combination events: the strongest pair of named events co-occurring within the combo window
    // (at most one combination per token and evaluation — keeps the vocabulary informative, not explosive)
    const recent = this.lastByToken.get(t.mint);
    if (recent && named.length > 0) {
      const severityOf = new Map(out.map((e) => [e.type, e.severity]));
      let best: { pair: string; score: number } | null = null;
      for (const a of named) {
        for (const [b, ts] of recent) {
          if (a === b || LIFECYCLE.has(b) || b.startsWith("anomaly:") || b.startsWith("combo:") || now - ts > this.comboWindowSec * 1000) continue;
          const score = (severityOf.get(a) ?? 1) + (severityOf.get(b) ?? 1);
          if (!best || score > best.score) best = { pair: [a, b].sort().join("+"), score };
        }
      }
      if (best) {
        this.fire(`combo:${best.pair}`, t.mint, now, 300, { severity: best.score / 2, direction: 0, context: {} }, "combination", 1, out);
      }
    }
    return out;
  }

  /** Lifecycle events derived directly from on-chain events. */
  fromMarketEvent(ev: MarketEvent): DetectedEvent[] {
    const out: DetectedEvent[] = [];
    const at = (ts: number, availableAt: number) => ({ ts, availableAt });
    switch (ev.kind) {
      case "create": {
        const e = this.lifecycle("token_created", ev.data.mint, at(ev.data.ts, ev.data.availableAt), { mayhem: ev.data.isMayhemMode ? 1 : 0 });
        out.push(e);
        break;
      }
      case "complete":
        out.push(this.lifecycle("curve_complete", ev.data.mint, at(ev.data.ts, ev.data.availableAt), {}));
        break;
      case "migrate":
        out.push(this.lifecycle("migration", ev.data.mint, at(ev.data.ts, ev.data.availableAt), { sol: Number(ev.data.solAmount) / 1e9 }));
        break;
      default:
        break;
    }
    return out;
  }

  private lifecycle(type: string, mint: string, t: { ts: number; availableAt: number }, context: Record<string, number>): DetectedEvent {
    let m = this.lastByToken.get(mint);
    if (!m) {
      m = new Map();
      this.lastByToken.set(mint, m);
    }
    m.set(type, t.ts);
    return {
      uid: idempotencyKey("event", type, mint, t.ts),
      type,
      mint,
      ts: t.ts,
      availableAt: t.availableAt,
      severity: 1,
      direction: 0,
      detector: "lifecycle",
      detectorVersion: 1,
      context,
    };
  }

  /** Seconds since the last event of each type for a token (for features). */
  eventAges(mint: string, now: number): Record<string, number> {
    const m = this.lastByToken.get(mint);
    const out: Record<string, number> = {};
    if (!m) return out;
    for (const [type, ts] of m) {
      if (type.startsWith("anomaly:") || type.startsWith("combo:")) continue;
      if (ts <= now) out[type] = (now - ts) / 1000;
    }
    return out;
  }

  forget(mint: string): void {
    this.lastByToken.delete(mint);
    for (const k of this.lastFired.keys()) if (k.startsWith(`${mint}|`)) this.lastFired.delete(k);
  }
}
