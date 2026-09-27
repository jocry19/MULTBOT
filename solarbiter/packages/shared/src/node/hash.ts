import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic idempotency key. The same logical action (e.g. "open position for strategy S on
 * signal X") always maps to the same key, so a retry or a replayed event cannot create a duplicate.
 */
export function idempotencyKey(...parts: (string | number | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|")).slice(0, 40);
}

/** Stable JSON (sorted keys) for hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
