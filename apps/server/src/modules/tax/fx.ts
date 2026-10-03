import type { Logger } from "pino";
import type { Database } from "../../db/database.js";

/**
 * Historical SOL/EUR rates for the tax documentation (minute resolution where available).
 * Source: Kraken public OHLC (1-minute candles for the last ~12h, hourly up to ~30 days, daily
 * beyond), cached in fx_rates. Returns null if no rate can be determined — the tax ledger then
 * records the EUR value as unknown instead of guessing.
 */
export class FxService {
  constructor(
    private readonly db: Database,
    private readonly provider: "kraken" | "coingecko" | "none",
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async solEur(ts: number): Promise<number | null> {
    const minute = Math.floor(ts / 60_000) * 60_000;
    const cached = await this.db.one<{ rate: number }>(
      "SELECT rate FROM fx_rates WHERE pair = 'SOL/EUR' AND ts <= $1 AND ts > $2 ORDER BY ts DESC LIMIT 1",
      [new Date(minute), new Date(minute - 3_600_000)],
    );
    if (cached) return cached.rate;
    if (this.provider === "none") return null;
    try {
      const rate = await this.fetchKraken(minute);
      return rate;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "fx rate lookup failed");
      return null;
    }
  }

  private async fetchKraken(minute: number): Promise<number | null> {
    const ageMs = Date.now() - minute;
    const interval = ageMs < 11 * 3_600_000 ? 1 : ageMs < 29 * 86_400_000 ? 60 : 1440;
    const since = Math.floor((minute - interval * 60_000 * 2) / 1000);
    const res = await this.fetchImpl(`https://api.kraken.com/0/public/OHLC?pair=SOLEUR&interval=${interval}&since=${since}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { error: string[]; result?: Record<string, unknown> };
    if (body.error.length > 0 || !body.result) throw new Error(body.error.join(", ") || "no result");
    const key = Object.keys(body.result).find((k) => k !== "last");
    const rows = (key ? body.result[key] : []) as [number, string, string, string, string, string, string, number][];
    const values = rows.map((r) => ({ ts: r[0] * 1000, close: Number(r[4]) })).filter((r) => r.close > 0);
    if (values.length === 0) return null;
    await this.db.insertMany(
      "fx_rates",
      ["pair", "ts", "rate", "source"],
      values.map((v) => ["SOL/EUR", new Date(v.ts), v.close, `kraken:${interval}m`]),
      "ON CONFLICT (pair, ts) DO NOTHING",
    );
    // candle containing (or immediately before) the requested minute
    const best = values.filter((v) => v.ts <= minute).sort((a, b) => b.ts - a.ts)[0] ?? values[0];
    return best?.close ?? null;
  }
}
