import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Secure headers (CSP, framing, sniffing, referrer, HSTS behind HTTPS) and per-IP rate limits.
 * The dashboard is same-origin; CORS is only answered for explicitly configured origins.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function registerSecurity(f: FastifyInstance, opts: { corsOrigins: string[]; production: boolean }): void {
  f.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (opts.production && req.protocol === "https") reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const origin = req.headers.origin;
    if (origin && opts.corsOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }
    return payload;
  });
  f.options("/api/*", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !opts.corsOrigins.includes(origin)) return reply.code(403).send();
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
    reply.header("Access-Control-Allow-Headers", "content-type,x-requested-with");
    return reply.code(204).send();
  });
}

/** Sliding-window request limiter per IP and bucket. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (xs.length >= limit) {
      this.hits.set(key, xs);
      return false;
    }
    xs.push(t);
    this.hits.set(key, xs);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export function rateLimitHook(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.url.startsWith("/api/")) return;
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    const login = req.url.startsWith("/api/auth/login");
    const [bucket, limit, windowMs] = login ? ["login", 10, 300_000] : mutating ? ["write", 60, 60_000] : ["read", 600, 60_000];
    if (!limiter.allow(`${bucket}:${req.ip}`, limit, windowMs)) {
      reply.header("Retry-After", "60");
      await reply.code(429).send({ error: "rate limit exceeded" });
    }
  };
}
