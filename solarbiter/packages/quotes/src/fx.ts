import type { Logger } from "pino";

export interface FxQuote {
  pair: "SOL/EUR";
  price: number;
  ts: number;
  source: string;
}

type Fetch = typeof fetch;

/**
 * SOL/EUR price (Kraken public ticker, last trade price). Used for EUR sizing, limits, reporting and
 * the tax ledger. A stale price blocks trading (sizes in EUR would be wrong).
 */
export class FxService {
  private current: FxQuote | null = null;
  private readonly history: FxQuote[] = [];
  lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get latest(): FxQuote | null {
    return this.current;
  }

  /** Price if not older than maxAgeMs, else null. */
  price(maxAgeMs = 120_000): number | null {
    if (!this.current || this.now() - this.current.ts > maxAgeMs) return null;
    return this.current.price;
  }

  /** Relative change over the last `windowMs` (for the unexpected-price-move breaker). */
  changeOver(windowMs: number): number | null {
    if (!this.current) return null;
    const cutoff = this.now() - windowMs;
    const old = this.history.find((h) => h.ts >= cutoff);
    return old ? this.current.price / old.price - 1 : null;
  }

  async refresh(): Promise<FxQuote> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await this.fetchImpl(this.url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
      const body = (await res.json()) as { error?: string[]; result?: Record<string, { c?: [string, string] }> };
      if (body.error && body.error.length) throw new Error(`FX error: ${body.error.join(", ")}`);
      const first = body.result ? Object.values(body.result)[0] : undefined;
      const price = Number(first?.c?.[0]);
      if (!Number.isFinite(price) || price <= 0) throw new Error("FX: invalid price");
      const q: FxQuote = { pair: "SOL/EUR", price, ts: this.now(), source: "kraken" };
      this.current = q;
      this.history.push(q);
      const cutoff = this.now() - 60 * 60_000;
      while (this.history.length && (this.history[0] as FxQuote).ts < cutoff) this.history.shift();
      this.lastError = null;
      return q;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn({ err: this.lastError }, "SOL/EUR refresh failed");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** For tests / replay. */
  set(price: number, ts = this.now()): void {
    this.current = { pair: "SOL/EUR", price, ts, source: "manual" };
    this.history.push(this.current);
  }
}
