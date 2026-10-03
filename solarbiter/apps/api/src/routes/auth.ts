import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, sessionToken } from "../auth.js";
import type { ApiContext } from "../context.js";

export async function registerAuthRoutes(f: FastifyInstance, ctx: ApiContext): Promise<void> {
  f.get("/api/auth/status", async (req) => ({
    authenticated: req.user !== null,
    user: req.user ? { username: req.user.username, role: req.user.role } : null,
    setupRequired: (await ctx.auth.userCount()) === 0,
  }));

  f.post("/api/auth/login", async (req, reply) => {
    const { username, password } = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }).parse(req.body);
    const token = await ctx.auth.login(username, password, req.ip, req.headers["user-agent"]);
    if (!token) {
      await ctx.db.query("INSERT INTO system_events (level, category, message, data) VALUES ('warning', 'auth', 'failed login', $1)", [JSON.stringify({ ip: req.ip, username })]);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: ctx.config.env === "production" && req.protocol === "https", path: "/", maxAge: ctx.config.sessionTtlHours * 3600 });
    await ctx.db.query("INSERT INTO system_events (level, category, message, data) VALUES ('info', 'auth', 'login', $1)", [JSON.stringify({ ip: req.ip, username })]);
    return { ok: true };
  });

  f.post("/api/auth/logout", async (req, reply) => {
    await ctx.auth.logout(sessionToken(req));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
