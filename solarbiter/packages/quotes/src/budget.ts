/**
 * Request budget for rate-limited quote providers (Jupiter plans: keyless 0.5 rps, free key 1 rps,
 * developer 10 rps …). Requests are admitted by priority so that the checks that protect money
 * (final re-quote before sending, shadow re-quote) are never starved by exploratory size ladders.
 */

export type QuotePriority = "final" | "requote" | "verify" | "ladder";

const PRIORITY_RESERVE: Record<QuotePriority, number> = {
  // fraction of the bucket that must remain for higher priorities
  final: 0,
  requote: 0,
  verify: 0.25,
  ladder: 0.5,
};

export class QuoteBudget {
  private tokens: number;
  private last: number;
  private readonly used: number[] = [];

  constructor(
    readonly rps: number,
    private readonly burst = Math.max(1, Math.ceil(rps * 2)),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = this.burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps);
    this.last = t;
  }

  /** Take `n` tokens if available for this priority. */
  tryTake(n: number, priority: QuotePriority): boolean {
    this.refill();
    const reserve = this.burst * PRIORITY_RESERVE[priority];
    if (this.tokens - n < reserve - 1e-9) return false;
    this.tokens -= n;
    const t = this.now();
    for (let i = 0; i < n; i++) this.used.push(t);
    return true;
  }

  /** Milliseconds until `n` tokens would be available at this priority. */
  waitMs(n: number, priority: QuotePriority): number {
    this.refill();
    const reserve = this.burst * PRIORITY_RESERVE[priority];
    const missing = n + reserve - this.tokens;
    return missing <= 0 ? 0 : Math.ceil((missing / this.rps) * 1000);
  }

  /** Wait for capacity (bounded). Returns false if it would take longer than maxWaitMs. */
  async take(n: number, priority: QuotePriority, maxWaitMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
    const w = this.waitMs(n, priority);
    if (w > maxWaitMs) return false;
    if (w > 0) await sleep(w);
    return this.tryTake(n, priority);
  }

  /** Requests in the last minute and the plan's per-minute limit. */
  usage(): { used1m: number; limit1m: number } {
    const cutoff = this.now() - 60_000;
    while (this.used.length && (this.used[0] as number) < cutoff) this.used.shift();
    return { used1m: this.used.length, limit1m: Math.floor(this.rps * 60) };
  }
}
