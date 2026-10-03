import { quoteAgeMs, type Quote } from "@solarbiter/shared";

/** A quote older than maxAgeMs must never be used for a decision. No exceptions. */
export function isFresh(q: Pick<Quote, "timestamp">, now: number, maxAgeMs: number): boolean {
  return quoteAgeMs(q, now) <= maxAgeMs;
}

/** Age of the oldest leg (the whole route is only as fresh as its stalest quote). */
export function routeAgeMs(legs: Pick<Quote, "timestamp">[], now: number): number {
  return legs.length ? Math.max(...legs.map((l) => quoteAgeMs(l, now))) : Number.POSITIVE_INFINITY;
}

let seq = 0;
/** Unique, time-sortable quote id. */
export function newQuoteId(now = Date.now()): string {
  seq = (seq + 1) % 1_000_000;
  return `q_${now.toString(36)}_${seq.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
