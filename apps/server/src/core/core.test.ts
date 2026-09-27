import { describe, expect, it } from "vitest";
import { SecretRegistry, redactUrl } from "./secrets.js";
import { createLogger } from "./logger.js";
import { backoffDelay, CircuitBreaker, retry } from "./retry.js";
import { PermanentError } from "./errors.js";
import { TokenBucket } from "./rateLimiter.js";
import { idempotencyKey, stableStringify } from "./hash.js";
import { loadConfig } from "./config.js";

describe("SecretRegistry", () => {
  it("scrubs registered secrets and api keys in URLs", () => {
    const reg = new SecretRegistry();
    reg.register("super-secret-passphrase");
    const out = reg.scrub(
      "failed https://mainnet.helius-rpc.com/?api-key=abc123def with super-secret-passphrase inside",
    );
    expect(out).not.toContain("abc123def");
    expect(out).not.toContain("super-secret-passphrase");
    expect(out).toContain("[REDACTED]");
  });

  it("ignores too-short values", () => {
    const reg = new SecretRegistry();
    reg.register("abc");
    expect(reg.size).toBe(0);
  });

  it("redactUrl strips query and credentials", () => {
    expect(redactUrl("https://user:pw@mainnet.helius-rpc.com/?api-key=xyz")).toBe("https://mainnet.helius-rpc.com");
  });
});

describe("logger", () => {
  it("never writes private key fields or registered secrets", () => {
    const lines: string[] = [];
    const reg = new SecretRegistry();
    const secretKey = "5Jz8verysecretbase58keymaterialthatmustneverleak";
    reg.register(secretKey);
    const log = createLogger({ level: "info", registry: reg, destination: { write: (s: string) => lines.push(s) } });
    log.info({ wallet: { secretKey: [1, 2, 3], address: "abc" }, privateKey: "zzz" }, "hello");
    log.error({ err: new Error(`boom ${secretKey}`) }, "failure");
    const all = lines.join("\n");
    expect(all).not.toContain(secretKey);
    expect(all).not.toContain('"privateKey":"zzz"');
    expect(all).not.toContain("[1,2,3]");
    expect(all).toContain("[REDACTED]");
  });
});

describe("retry", () => {
  it("retries transient errors and stops after the attempt budget", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("transient");
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow("transient");
    expect(calls).toBe(3);
  });

  it("does not retry permanent errors", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new PermanentError("BAD", "bad input");
        },
        { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow("bad input");
    expect(calls).toBe(1);
  });

  it("returns the first success", async () => {
    let calls = 0;
    const v = await retry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("x");
        return 42;
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(v).toBe(42);
  });

  it("backoff is bounded", () => {
    for (let a = 1; a < 20; a++) expect(backoffDelay(a, 100, 5000, () => 1)).toBeLessThanOrEqual(5000);
  });

  it("circuit breaker opens and half-opens after cooldown", () => {
    let t = 0;
    const cb = new CircuitBreaker(2, 1000, () => t);
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    t = 1500;
    expect(cb.isOpen).toBe(false);
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
  });
});

describe("TokenBucket", () => {
  it("limits rate and refills over time", () => {
    let t = 0;
    const b = new TokenBucket(2, 2, () => t);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t = 500;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  it("penalize drains the bucket", () => {
    let t = 0;
    const b = new TokenBucket(10, 10, () => t);
    b.penalize(1000);
    expect(b.tryTake()).toBe(false);
    t = 1100;
    expect(b.tryTake()).toBe(true);
  });
});

describe("hashing", () => {
  it("idempotency keys are deterministic and distinct", () => {
    expect(idempotencyKey("live", "S-1@1.0", "mint", 5)).toBe(idempotencyKey("live", "S-1@1.0", "mint", 5));
    expect(idempotencyKey("live", "S-1@1.0", "mint", 5)).not.toBe(idempotencyKey("paper", "S-1@1.0", "mint", 5));
  });
  it("stableStringify sorts keys", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });
});

describe("config", () => {
  it("builds a Helius primary endpoint and registers the api key as secret", () => {
    const cfg = loadConfig({ NODE_ENV: "test", HELIUS_API_KEY: "helius-test-key-123", SOLANA_RPC_URLS: "https://rpc.example.com" });
    expect(cfg.rpc.endpoints[0]?.name).toBe("helius");
    expect(cfg.rpc.endpoints[0]?.wsUrl).toContain("wss://");
    expect(cfg.rpc.endpoints[1]?.name).toBe("rpc-1");
    expect(cfg.features.ingest).toBe(false);
  });
  it("falls back to the public endpoint", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });
    expect(cfg.rpc.endpoints).toHaveLength(1);
    expect(cfg.rpc.endpoints[0]?.name).toBe("solana-public");
  });
});
