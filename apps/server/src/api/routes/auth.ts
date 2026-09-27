import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../../app/app.js";
import { SESSION_COOKIE, verifyPassword, type AuthPolicy } from "../auth.js";

const attempts = new Map<string, { n: number; until: number }>();

export async function registerAuthRoutes(f: FastifyInstance, app: App, policy: AuthPolicy): Promise<void> {
  f.get("/api/auth/status", async (req) => {
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    return { authRequired: policy.enabled, authenticated: policy.enabled ? await policy.sessions.valid(token) : true };
  });

  f.post("/api/auth/login", async (req, reply) => {
    if (req.headers["x-requested-with"] !== "multbot") return reply.code(403).send({ error: "missing X-Requested-With header" });
    if (!policy.enabled) return { ok: true, authRequired: false };
    // simple brute-force protection per IP
    const a = attempts.get(req.ip) ?? { n: 0, until: 0 };
    if (a.until > Date.now()) return reply.code(429).send({ error: "too many attempts, try again later" });
    const { password } = z.object({ password: z.string().min(1).max(500) }).parse(req.body);
    const ok = await verifyPassword(password, app.config.auth.adminPasswordHash as string);
    if (!ok) {
      a.n++;
      if (a.n >= 5) {
        a.until = Date.now() + 5 * 60_000;
        a.n = 0;
      }
      attempts.set(req.ip, a);
      app.activity.warn("auth", `Failed dashboard login from ${req.ip}`);
      return reply.code(401).send({ error: "invalid password" });
    }
    attempts.delete(req.ip);
    const token = await policy.sessions.create(req.ip, req.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: app.config.env === "production" && req.protocol === "https",
      path: "/",
      maxAge: app.config.auth.sessionTtlHours * 3600,
    });
    app.activity.info("auth", "Dashboard login");
    return { ok: true };
  });

  f.post("/api/auth/logout", async (req, reply) => {
    await policy.sessions.destroy((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
