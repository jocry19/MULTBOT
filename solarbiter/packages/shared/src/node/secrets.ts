/**
 * Registry of secret values that must never appear in any output.
 *
 * Every log line passes through `scrub()` before it is written, so even if a secret ends up in an
 * error message (e.g. an RPC URL with an api key inside a fetch error) it is replaced by a marker.
 * Private key material is registered here too, in its base58 and JSON-array forms.
 */
export class SecretRegistry {
  private readonly secrets = new Set<string>();
  private pattern: RegExp | null = null;

  register(value: string | undefined | null): void {
    if (!value || value.length < 8) return;
    if (this.secrets.has(value)) return;
    this.secrets.add(value);
    this.pattern = null;
  }

  get size(): number {
    return this.secrets.size;
  }

  scrub(text: string): string {
    let out = text.replace(API_KEY_IN_URL, "$1[REDACTED]");
    if (this.secrets.size === 0) return out;
    if (!this.pattern) {
      const escaped = [...this.secrets]
        .sort((a, b) => b.length - a.length)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      this.pattern = new RegExp(escaped.join("|"), "g");
    }
    out = out.replace(this.pattern, "[REDACTED]");
    return out;
  }
}

/** Matches `api-key=...`, `apikey=...`, `token=...` query parameters in URLs. */
const API_KEY_IN_URL = /((?:api[-_]?key|apikey|token|access_token|key)=)[^&\s"']+/gi;

/** Process-wide registry used by the logger. */
export const secrets = new SecretRegistry();

/** Human-safe representation of an endpoint URL (no query string, no credentials). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
