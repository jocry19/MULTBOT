import { sleep } from "./clock.js";
import { PermanentError } from "./errors.js";

export interface RetryOptions {
  /** Total attempts including the first one. Always finite — no endless retry loops. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  /** Return false to stop retrying immediately. Defaults to "retry everything except PermanentError". */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // full jitter
  return Math.round(exp / 2 + random() * (exp / 2));
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err, attempt) : !(err instanceof PermanentError);
      if (!retryable || attempt === attempts || opts.signal?.aborted) break;
      const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

/** Simple circuit breaker: opens after `threshold` consecutive failures for `cooldownMs`. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      // half-open: allow a probe
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
