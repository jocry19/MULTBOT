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

  /** Next candidate to verify, or null (nothing eligible / per-minute cap reached). */
  next(): Candidate | null {
    this.prune();
    if (this.taken.length >= this.opts.maxPerMinute) return null;
    const t = this.now();
    const eligible = [...this.pending.values()]
      .filter((c) => {
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
