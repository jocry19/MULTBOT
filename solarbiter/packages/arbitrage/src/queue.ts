import type { Candidate } from "./screen.js";

export interface QueueOptions {
  /** Firm-quote verifications per minute (bounded by the routing API plan). */
  maxPerMinute: number;
  /** Do not re-check the same route sooner than this … */
  cooldownMs: number;
  /** … unless its screening spread improved by at least this much (bps). */
  improvementBps: number;
  /** Candidates older than this (from stale pool state) are dropped. */
  maxAgeMs: number;
}

/**
 * Chooses which screened candidate gets the scarce firm quotes next: best spread first, with a
 * cooldown per route and a per-minute cap.
 */
export class CandidateQueue {
  private readonly pending = new Map<string, Candidate>();
  private readonly lastChecked = new Map<string, { at: number; spreadBps: number }>();
  /** Routes whose firm quotes contradicted the screening (e.g. a DLMM active bin without depth). */
  private readonly strikes = new Map<string, { n: number; until: number }>();
  private readonly taken: number[] = [];

  constructor(
    private opts: QueueOptions,
    private readonly now: () => number = Date.now,
  ) {}

  configure(opts: Partial<QueueOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Replace the pending set with the latest screening result. */
  offer(candidates: Candidate[]): void {
    this.pending.clear();
    for (const c of candidates) this.pending.set(c.key, c);
  }

  size(): number {
    return this.pending.size;
  }

  private prune(): void {
    const t = this.now();
    while (this.taken.length && (this.taken[0] as number) <= t - 60_000) this.taken.shift();
    for (const [k, c] of this.pending) if (t - c.oldestStateAt > this.opts.maxAgeMs) this.pending.delete(k);
    if (this.lastChecked.size > 5_000) {
      for (const [k, v] of this.lastChecked) if (t - v.at > this.opts.cooldownMs * 10) this.lastChecked.delete(k);
    }
  }

  /** Remaining verifications this minute. */
  remaining(): number {
    this.prune();
    return Math.max(0, this.opts.maxPerMinute - this.taken.length);
  }

  /**
   * Feedback from the firm quotes. A route whose executable gross is far below its screening spread
   * is backed off exponentially (30 s, 1, 2, 4 … up to 15 min); a consistent route is reset.
   */
  feedback(key: string, screenNetBps: number, firmGrossBps: number | null, toleranceBps = 20): void {
    const t = this.now();
    if (firmGrossBps === null || firmGrossBps < screenNetBps - toleranceBps) {
      const n = (this.strikes.get(key)?.n ?? 0) + 1;
      this.strikes.set(key, { n, until: t + Math.min(15 * 60_000, this.opts.cooldownMs * 2 ** (n - 1)) });
    } else {
      this.strikes.delete(key);
    }
  }

  /** Routes currently backed off (for the UI). */
  backedOff(): { key: string; strikes: number; untilMs: number }[] {
    const t = this.now();
    return [...this.strikes.entries()].filter(([, v]) => v.until > t).map(([key, v]) => ({ key, strikes: v.n, untilMs: v.until - t }));
  }

  /** Next candidate to verify, or null (nothing eligible / per-minute cap reached). */
  next(): Candidate | null {
    this.prune();
    if (this.taken.length >= this.opts.maxPerMinute) return null;
    const t = this.now();
    const eligible = [...this.pending.values()]
      .filter((c) => {
        const strike = this.strikes.get(c.key);
        if (strike && t < strike.until) return false;
        const last = this.lastChecked.get(c.key);
        return !last || t - last.at >= this.opts.cooldownMs || c.netSpreadBps - last.spreadBps >= this.opts.improvementBps;
      })
      .sort((a, b) => b.netSpreadBps - a.netSpreadBps);
    const c = eligible[0];
    if (!c) return null;
    this.pending.delete(c.key);
    this.lastChecked.set(c.key, { at: t, spreadBps: c.netSpreadBps });
    this.taken.push(t);
    return c;
  }
}
