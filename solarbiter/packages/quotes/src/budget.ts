/**
 * Request budget for the rate-limited routing API. Jupiter enforces its plan limits with a 60-second
 * sliding window (keyless 30/min, free 60/min, developer 600/min …; quote and swap-instructions share
 * the bucket). Bursts inside the window are allowed — which is what lets all legs of a route be quoted
 * within the quote-freshness limit.
 *
 * Requests are admitted by priority so the checks that protect money (final re-quote before sending,
 * shadow re-quote) are never starved by exploratory size-ladder quotes.
 */

export type QuotePriority = "final" | "requote" | "verify" | "ladder";

/** Share of the window that must stay free for higher priorities. */
const PRIORITY_RESERVE: Record<QuotePriority, number> = {
  final: 0,
  requote: 0,
  verify: 0.25,
  ladder: 0.5,
};

/** Keep a small margin below the plan limit (other clients of the same key, clock skew). */
const SAFETY_MARGIN = 0.9;

export class QuoteBudget {
  readonly capacity: number;
  private readonly stamps: number[] = [];

  constructor(
    readonly rps: number,
    private readonly now: () => number = Date.now,
    readonly windowMs = 60_000,
  ) {
    this.capacity = Math.max(1, Math.floor(((rps * windowMs) / 1000) * SAFETY_MARGIN));
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
  }

  private allowance(priority: QuotePriority): number {
    return Math.floor(this.capacity * (1 - PRIORITY_RESERVE[priority]));
  }

  /** Requests still admissible right now at this priority. */
  available(priority: QuotePriority): number {
    this.prune();
    return Math.max(0, this.allowance(priority) - this.stamps.length);
  }

  /** Take `n` requests if the window allows them at this priority. */
  tryTake(n: number, priority: QuotePriority): boolean {
    if (this.available(priority) < n) return false;
    const t = this.now();
    for (let i = 0; i < n; i++) this.stamps.push(t);
    return true;
  }

  /** Milliseconds until `n` requests would be admissible at this priority. */
  waitMs(n: number, priority: QuotePriority): number {
    this.prune();
    const allowed = this.allowance(priority);
    if (n > allowed) return Number.POSITIVE_INFINITY;
    const excess = this.stamps.length + n - allowed;
    if (excess <= 0) return 0;
    const releasing = this.stamps[excess - 1] as number;
    return Math.max(0, releasing + this.windowMs - this.now() + 1);
  }

  /** Wait for capacity (bounded). Returns false if it would take longer than maxWaitMs. */
  async take(n: number, priority: QuotePriority, maxWaitMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
    const w = this.waitMs(n, priority);
    if (w > maxWaitMs) return false;
    if (w > 0) await sleep(w);
    return this.tryTake(n, priority);
  }

  /** Requests in the current window and the (margin-adjusted) window limit. */
  usage(): { used1m: number; limit1m: number } {
    this.prune();
    return { used1m: this.stamps.length, limit1m: this.capacity };
  }
}
