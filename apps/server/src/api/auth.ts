import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sha256Hex } from "../core/hash.js";
import type { Database } from "../db/database.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * Admin authentication.
 *   - password hash format: scrypt$N$r$p$<salt b64>$<hash b64>  (create with `pnpm auth:hash-password`)
 *   - session tokens: 32 random bytes; only their SHA-256 is stored (auth_sessions)
 *   - cookie: httpOnly, SameSite=Strict; mutating requests must also send X-Requested-With
 */

export const SESSION_COOKIE = "mb_session";
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly ttlHours: number,
  ) {}

  async create(ip: string | undefined, userAgent: string | undefined): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO auth_sessions (id, expires_at, ip, user_agent) VALUES ($1, now() + ($2 || ' hours')::interval, $3, $4)", [
      sha256Hex(token),
      String(this.ttlHours),
      ip ?? null,
      (userAgent ?? "").slice(0, 300),
    ]);
    return token;
  }

  async valid(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const row = await this.db.one("SELECT 1 FROM auth_sessions WHERE id = $1 AND expires_at > now()", [sha256Hex(token)]);
    return row !== null;
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.query("DELETE FROM auth_sessions WHERE id = $1", [sha256Hex(token)]);
  }
}

export interface AuthPolicy {
  /** Password configured → every API route requires a session. */
  enabled: boolean;
  sessions: SessionStore;
}

/** Fastify preHandler: session check + CSRF header check for state-changing methods. */
export function authGuard(policy: AuthPolicy) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "multbot") {
      await reply.code(403).send({ error: "missing X-Requested-With header" });
      return;
    }
    if (!policy.enabled) return;
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (!(await policy.sessions.valid(token))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

/** Real-money actions are refused unless a password is configured (and the session is valid). */
export function requireConfiguredAuth(policy: AuthPolicy) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!policy.enabled) {
      await reply.code(403).send({
        error: "Real-money actions require ADMIN_PASSWORD_HASH to be configured (pnpm auth:hash-password).",
      });
    }
  };
}
