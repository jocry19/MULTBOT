import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solarbiter/shared";
import { CircuitBreaker, PermanentError, TransientError } from "@solarbiter/shared/node";

/** Jito requires at least this tip for a bundle to be considered. */
export const MIN_JITO_TIP_LAMPORTS = 1_000;
/** A bundle holds at most five transactions. */
export const MAX_BUNDLE_TRANSACTIONS = 5;

export interface TipFloor {
  at: number;
  /** Landed-tip percentiles in lamports. */
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema50: number;
}

export type BundleState = "Invalid" | "Pending" | "Failed" | "Landed";

export interface InflightStatus {
  bundleId: string;
  status: BundleState;
  landedSlot: number | null;
}

export interface BundleStatus {
  bundleId: string;
  transactions: string[];
  slot: number;
  confirmationStatus: "processed" | "confirmed" | "finalized";
  err: unknown;
}

type Fetch = typeof fetch;

/**
 * Jito block engine client (JSON-RPC over HTTPS):
 *   POST /api/v1/bundles               sendBundle, getTipAccounts
 *   POST /api/v1/getInflightBundleStatuses
 *   POST /api/v1/getBundleStatuses
 *   GET  bundles.jito.wtf/api/v1/bundles/tip_floor (landed tip percentiles, SOL)
 * Default limit: 1 request / second / IP / region — requests are spaced accordingly.
 */
export class JitoClient {
  private readonly breaker: CircuitBreaker;
  private lastRequestAt = 0;
  private tipAccounts: string[] = [];
  private tipFloor: TipFloor | null = null;
  lastError: string | null = null;
  lastOkAt: number | null = null;

  constructor(
    private readonly opts: { blockEngineUrl: string; tipFloorUrl: string; auth?: string; fetchImpl?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number },
  ) {
    this.breaker = new CircuitBreaker(5, 30_000, this.now);
  }

  private now = (): number => (this.opts.now ?? Date.now)();

  available(): { ok: boolean; reason: string | null } {
    if (this.breaker.isOpen) return { ok: false, reason: `Jito unavailable: ${this.lastError ?? "circuit open"}` };
    return { ok: true, reason: null };
  }

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const gap = (this.opts.minIntervalMs ?? 1_000) - (this.now() - this.lastRequestAt);
    if (gap > 0) await (this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(gap);
    this.lastRequestAt = this.now();
    const f = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await f(`${this.opts.blockEngineUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.auth ? { "x-jito-auth": this.opts.auth } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.status === 429) throw new TransientError("JITO_RATE_LIMIT", "Jito rate limit");
      if (res.status >= 500) throw new TransientError("JITO_5XX", `Jito HTTP ${res.status}`);
      const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new PermanentError("JITO_ERROR", `Jito ${method}: ${body.error.message}`);
      if (!res.ok) throw new PermanentError("JITO_HTTP", `Jito HTTP ${res.status}`);
      this.breaker.recordSuccess();
      this.lastOkAt = this.now();
      return body.result as T;
    } catch (err) {
      this.lastError = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
      if (!(err instanceof PermanentError)) this.breaker.recordFailure();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getTipAccounts(): Promise<string[]> {
    if (this.tipAccounts.length) return this.tipAccounts;
    const r = await this.rpc<string[]>("/api/v1/bundles", "getTipAccounts", []);
    if (!Array.isArray(r) || r.length === 0) throw new PermanentError("JITO_TIP_ACCOUNTS", "no tip accounts returned");
    for (const a of r) new PublicKey(a); // validate
    this.tipAccounts = r;
    return r;
  }

  cachedTipAccounts(): string[] {
    return this.tipAccounts;
  }

  async refreshTipFloor(): Promise<TipFloor> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.opts.tipFloorUrl, { headers: { accept: "application/json" } });
    if (!res.ok) throw new TransientError("JITO_TIP_FLOOR", `tip floor HTTP ${res.status}`);
    const arr = (await res.json()) as Record<string, number>[];
    const x = arr[0];
    if (!x) throw new TransientError("JITO_TIP_FLOOR", "empty tip floor");
    const l = (k: string) => Math.round((Number(x[k]) || 0) * LAMPORTS_PER_SOL);
    this.tipFloor = {
      at: this.now(),
      p25: l("landed_tips_25th_percentile"),
      p50: l("landed_tips_50th_percentile"),
      p75: l("landed_tips_75th_percentile"),
      p95: l("landed_tips_95th_percentile"),
      p99: l("landed_tips_99th_percentile"),
      ema50: l("ema_landed_tips_50th_percentile"),
    };
    return this.tipFloor;
  }

  latestTipFloor(): TipFloor | null {
    return this.tipFloor;
  }

  /** Submit signed transactions (base64) as one bundle; returns the bundle id. */
  async sendBundle(base64Txs: string[]): Promise<string> {
    if (base64Txs.length === 0 || base64Txs.length > MAX_BUNDLE_TRANSACTIONS) throw new PermanentError("JITO_BUNDLE_SIZE", `bundle must contain 1–${MAX_BUNDLE_TRANSACTIONS} transactions`);
    return this.rpc<string>("/api/v1/bundles", "sendBundle", [base64Txs, { encoding: "base64" }]);
  }

  async getInflightBundleStatuses(ids: string[]): Promise<InflightStatus[]> {
    const r = await this.rpc<{ value: { bundle_id: string; status: BundleState; landed_slot: number | null }[] }>("/api/v1/getInflightBundleStatuses", "getInflightBundleStatuses", [ids.slice(0, 5)]);
    return (r?.value ?? []).map((v) => ({ bundleId: v.bundle_id, status: v.status, landedSlot: v.landed_slot }));
  }

  async getBundleStatuses(ids: string[]): Promise<(BundleStatus | null)[]> {
    const r = await this.rpc<{ value: ({ bundle_id: string; transactions: string[]; slot: number; confirmation_status: BundleStatus["confirmationStatus"]; err: unknown } | null)[] }>(
      "/api/v1/getBundleStatuses",
      "getBundleStatuses",
      [ids.slice(0, 5)],
    );
    return (r?.value ?? []).map((v) => (v ? { bundleId: v.bundle_id, transactions: v.transactions, slot: v.slot, confirmationStatus: v.confirmation_status, err: v.err } : null));
  }
}

/** Tip transfer instruction to a (random) Jito tip account. */
export function tipInstruction(from: string, tipAccounts: string[], lamports: number, random = Math.random): TransactionInstruction {
  if (lamports < MIN_JITO_TIP_LAMPORTS) throw new PermanentError("JITO_TIP_TOO_SMALL", `tip must be at least ${MIN_JITO_TIP_LAMPORTS} lamports`);
  const to = tipAccounts[Math.floor(random() * tipAccounts.length)];
  if (!to) throw new PermanentError("JITO_TIP_ACCOUNTS", "no tip accounts");
  return SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports });
}

/**
 * Tip for a bundle: the landed-tip percentile (interpolated), at least the Jito minimum, capped by
 * the configured maximum and by a share of the expected profit. The tip is always counted as a cost.
 */
export function chooseTip(floor: TipFloor | null, o: { percentile: number; maxTipLamports: number; expectedProfitLamports: bigint; maxShareOfProfit: number }): bigint {
  let tip = MIN_JITO_TIP_LAMPORTS * 10;
  if (floor) {
    const pts: [number, number][] = [
      [25, floor.p25],
      [50, floor.p50],
      [75, floor.p75],
      [95, floor.p95],
      [99, floor.p99],
    ];
    const p = Math.min(99, Math.max(25, o.percentile));
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, va] = pts[i] as [number, number];
      const [b, vb] = pts[i + 1] as [number, number];
      if (p >= a && p <= b) {
        tip = va + ((vb - va) * (p - a)) / (b - a);
        break;
      }
    }
  }
  const shareCap = Number(o.expectedProfitLamports) * o.maxShareOfProfit;
  tip = Math.min(tip, o.maxTipLamports, Math.max(MIN_JITO_TIP_LAMPORTS, shareCap));
  return BigInt(Math.max(MIN_JITO_TIP_LAMPORTS, Math.ceil(tip)));
}
