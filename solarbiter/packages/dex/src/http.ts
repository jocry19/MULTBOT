import { PermanentError, TransientError } from "@solarbiter/shared/node";

export type Fetch = typeof fetch;

/** GET/POST JSON with a timeout; 429/5xx/network → TransientError, other HTTP errors → PermanentError. */
export async function fetchJson<T>(
  url: string,
  opts: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; fetchImpl?: Fetch } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000);
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(url, {
      method: opts.method ?? "GET",
      headers: { accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.status === 429) throw new TransientError("HTTP_429", `rate limited: ${new URL(url).host}`);
    if (res.status >= 500) throw new TransientError("HTTP_5XX", `HTTP ${res.status} from ${new URL(url).host}`);
    if (!res.ok) throw new PermanentError("HTTP_4XX", `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new TransientError("HTTP_TIMEOUT", `timeout: ${new URL(url).host}`);
    if (err instanceof TransientError || err instanceof PermanentError) throw err;
    throw new TransientError("HTTP_NETWORK", `${new URL(url).host}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
