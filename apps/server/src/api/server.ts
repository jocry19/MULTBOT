import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { StreamMessage } from "@multbot/shared";
import { ZodError } from "zod";
import type { App } from "../app/app.js";
import { PermanentError } from "../core/errors.js";
import { metricsRegistry } from "../core/metrics.js";
import { authGuard, SessionStore, type AuthPolicy } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerStrategyRoutes } from "./routes/strategies.js";
import { registerSystemRoutes, buildHealth } from "./routes/system.js";
import { registerPaperRoutes } from "./routes/paper.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerLiveRoutes } from "./routes/live.js";

/** Serialises bigint safely (on-chain amounts) — never crash on JSON encoding. */
function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const f = Fastify({ logger: false, bodyLimit: 1_048_576 });
  f.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
  await f.register(cookie);
  await f.register(websocket);

  const policy: AuthPolicy = {
    enabled: Boolean(app.config.auth.adminPasswordHash),
    sessions: new SessionStore(app.db, app.config.auth.sessionTtlHours),
  };
  const guard = authGuard(policy);
  f.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/auth/login") || req.url.startsWith("/api/auth/status")) return;
    await guard(req, reply);
  });

  f.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation failed", issues: err.issues });
    if (err instanceof PermanentError) return reply.code(400).send({ error: err.message, code: err.code });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, "api error");
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  await registerAuthRoutes(f, app, policy);
  await registerSystemRoutes(f, app, policy);
  await registerMarketRoutes(f, app);
  await registerStrategyRoutes(f, app, policy);
  await registerPaperRoutes(f, app);
  await registerResearchRoutes(f, app);
  await registerLiveRoutes(f, app, policy);

  f.get("/metrics", async (req, reply) => {
    const ip = req.ip;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return reply.code(403).send("forbidden");
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // live stream for the dashboard
  f.get("/api/stream", { websocket: true }, (socket) => {
    const send = (m: StreamMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m, jsonReplacer));
    };
    const offActivity = app.bus.on("activity", (a) => send({ type: "activity", payload: a }));
    const offInvalidate = app.bus.on("invalidate", (keys) => send({ type: "invalidate", payload: { keys } }));
    const timer = setInterval(() => {
      void buildHealth(app).then((h) => send({ type: "health", payload: h }));
    }, 5_000);
    void buildHealth(app).then((h) => send({ type: "health", payload: h }));
    socket.on("close", () => {
      offActivity();
      offInvalidate();
      clearInterval(timer);
    });
  });

  // built dashboard (single page app)
  const dist = app.config.http.webDistDir;
  if (dist && fs.existsSync(dist)) {
    await f.register(fastifyStatic, { root: path.resolve(dist), wildcard: false });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return f;
}
