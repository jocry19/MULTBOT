import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Database } from "@solarbiter/database";
import { sha256Hex } from "@solarbiter/shared/node";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * Authentication:
 *   - users table; password hash scrypt$N$r$p$<salt>$<hash> (create with `pnpm user:create`)
 *   - session token: 32 random bytes in an httpOnly SameSite=Strict cookie; only its SHA-256 is stored
 *   - every state-changing request must carry X-Requested-With: solarbiter (CSRF protection)
 *   - critical actions (live enable, level up, emergency release) additionally re-check the password
 */
export const SESSION_COOKIE = "sb_session";
export const CSRF_HEADER_VALUE = "solarbiter";
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("password must be at least 12 characters");
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

export class Auth {
  constructor(
    private readonly db: Database,
    private readonly ttlHours: number,
  ) {}

  async userCount(): Promise<number> {
    const r = await this.db.one<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE NOT disabled");
    return Number(r?.n ?? 0);
  }

  async login(username: string, password: string, ip: string, userAgent: string | undefined): Promise<string | null> {
    const u = await this.db.one<{ id: string; password_hash: string; disabled: boolean }>("SELECT id, password_hash, disabled FROM users WHERE username = $1", [username]);
    // constant-ish time: verify against a dummy hash when the user does not exist
    const hash = u?.password_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(password, hash);
    if (!u || u.disabled || !ok) return null;
    const token = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)", [sha256Hex(token), u.id, String(this.ttlHours), ip, (userAgent ?? "").slice(0, 300)]);
    await this.db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [u.id]);
    await this.db.query("DELETE FROM sessions WHERE expires_at < now()");
    return token;
  }

  async session(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const r = await this.db.one<{ id: string; username: string; role: string }>(
      "SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled",
      [sha256Hex(token)],
    );
    return r ? { id: Number(r.id), username: r.username, role: r.role } : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256Hex(token)]);
  }

  /** Re-authentication for critical actions. */
  async checkPassword(userId: number, password: string): Promise<boolean> {
    const u = await this.db.one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1 AND NOT disabled", [userId]);
    return u ? verifyPassword(password, u.password_hash) : false;
  }

  async createUser(username: string, password: string, role = "admin"): Promise<void> {
    await this.db.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [username, await hashPassword(password), role]);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function sessionToken(req: FastifyRequest): string | undefined {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
}

/** onRequest guard for /api/*: CSRF header for state changes, valid session for everything. */
export function apiGuard(auth: Auth, open: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    req.user = null;
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== CSRF_HEADER_VALUE) {
      await reply.code(403).send({ error: "missing X-Requested-With header" });
      return;
    }
    req.user = await auth.session(sessionToken(req));
    if (open.includes(url)) return;
    if (!req.user) await reply.code(401).send({ error: "unauthorized" });
  };
}
