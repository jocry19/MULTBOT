import { sleep } from "./clock.js";

/** Token bucket. `take()` resolves when a token is available (bounded wait). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number = Math.max(1, ratePerSec),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
      this.last = t;
    }
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available. */
  waitTimeMs(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.ratePerSec) * 1000);
  }

  async take(n = 1, maxWaitMs = 30_000, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + maxWaitMs;
    while (!this.tryTake(n)) {
      const wait = this.waitTimeMs(n);
      if (this.now() + wait > deadline) throw new Error("rate limiter wait exceeded");
      await sleep(Math.max(5, wait), signal);
    }
  }

  /** Temporarily drain the bucket (e.g. after an HTTP 429). */
  penalize(ms: number): void {
    this.refill();
    this.tokens = Math.min(this.tokens, -(ms / 1000) * this.ratePerSec);
  }
}
