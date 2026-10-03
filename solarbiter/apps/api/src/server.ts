import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { stringifyBig, type RealtimeEvent } from "@solarbiter/shared";
import { PermanentError } from "@solarbiter/shared/node";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { apiGuard, sessionToken } from "./auth.js";
import type { ApiContext } from "./context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerControlRoutes } from "./routes/control.js";
import { registerReadRoutes } from "./routes/read.js";
import { registerReportRoutes } from "./routes/reports.js";
import { RateLimiter, inlineScriptHashes, rateLimitHook, registerSecurity } from "./security.js";

export const OPEN_ROUTES = ["/api/auth/login", "/api/auth/status", "/api/health"];

export async function buildServer(ctx: ApiContext): Promise<FastifyInstance> {
  const f = Fastify({ logger: false, bodyLimit: 262_144, trustProxy: false });
  f.setReplySerializer((payload) => stringifyBig(payload));
  f.decorateRequest("user", null);
  await f.register(cookie);
  await f.register(websocket, { options: { maxPayload: 4_096 } });
  registerSecurity(f, { corsOrigins: ctx.config.http.corsOrigins, production: ctx.config.env === "production", scriptHashes: inlineScriptHashes(ctx.config.http.webDistDir) });
  f.addHook("onRequest", rateLimitHook(new RateLimiter()));
  f.addHook("onRequest", apiGuard(ctx.auth, OPEN_ROUTES));

  f.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation failed", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof PermanentError) return reply.code(400).send({ error: err.message, code: err.code });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) ctx.log.error({ err }, "api error");
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  f.get("/api/health", async () => ({ ok: true, database: await ctx.db.ping(), redis: ctx.bus.isHealthy }));
  await registerAuthRoutes(f, ctx);
  await registerReadRoutes(f, ctx);
  await registerControlRoutes(f, ctx);
  await registerReportRoutes(f, ctx);

  // realtime: Redis events → browser (authenticated sessions only)
  const sockets = new Set<{ send: (s: string) => void; readyState: number; OPEN: number }>();
  ctx.bus.onEvent((e: RealtimeEvent) => {
    const msg = stringifyBig(e);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  });
  f.get("/api/ws", { websocket: true }, async (socket, req) => {
    const user = await ctx.auth.session(sessionToken(req));
    if (!user) {
      socket.close(4401, "unauthorized");
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // built dashboard (static export) — same origin as the API
  const dist = ctx.config.http.webDistDir;
  if (dist && fs.existsSync(dist)) {
    await f.register(fastifyStatic, { root: path.resolve(dist), wildcard: false, extensions: ["html"] });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      const clean = (req.url.split("?")[0] ?? "/").replace(/\/+$/, "");
      const candidate = path.join(path.resolve(dist), `${clean}.html`);
      if (clean && fs.existsSync(candidate) && candidate.startsWith(path.resolve(dist))) return reply.sendFile(`${clean.slice(1)}.html`);
      return reply.sendFile("index.html");
    });
  }
  return f;
}
