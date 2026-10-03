/**
 * API integration: real PostgreSQL (test database) and real Redis, Fastify via inject().
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATE_KEYS, StateStore, createTestDatabase, type Database } from "@solarbiter/database";
import { RedisBus, loadConfig, silentLogger } from "@solarbiter/shared/node";
import type { FastifyInstance } from "fastify";
import { Auth } from "./auth.js";
import { buildServer } from "./server.js";

const H = { "x-requested-with": "solarbiter", "content-type": "application/json" };
let db: Database;
let bus: RedisBus;
let store: StateStore;
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  db = await createTestDatabase();
  const config = loadConfig({ NODE_ENV: "test", LIVE_MODE: "false" } as NodeJS.ProcessEnv);
  store = new StateStore(db);
  await store.load();
  bus = new RedisBus(config.redisUrl, silentLogger());
  await bus.connect();
  const auth = new Auth(db, 1);
  await auth.createUser("tester", "correct-horse-battery");
  app = await buildServer({ config, db, store, bus, auth, log: silentLogger() });
});

afterAll(async () => {
  await app?.close();
  await bus?.close();
  await db?.close();
});

describe("API", () => {
  it("requires a session for every API route and the CSRF header for state changes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/bot/start" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { username: "tester", password: "wrong-password-1" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { username: "tester", password: "correct-horse-battery" } });
    expect(ok.statusCode).toBe(200);
    const set = String(ok.headers["set-cookie"]);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    cookie = set.split(";")[0] as string;
    const st = await app.inject({ method: "GET", url: "/api/status", headers: { cookie } });
    expect(st.statusCode).toBe(200);
    expect(typeof st.json().botState).toBe("string"); // OFFLINE without a worker heartbeat
    expect(st.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(st.headers["x-frame-options"]).toBe("DENY");
  });

  it("live trading cannot be enabled without LIVE_MODE, the gate, a wallet and the exact phrase", async () => {
    const r = await app.inject({ method: "POST", url: "/api/live/enable", headers: { ...H, cookie }, payload: { confirmation: "enable live", password: "correct-horse-battery" } });
    expect(r.statusCode).toBe(409);
    const reasons: string[] = r.json().reasons;
    expect(reasons.join(" ")).toMatch(/ENABLE LIVE TRADING/);
    expect(reasons.join(" ")).toMatch(/LIVE_MODE=false/);
    expect(reasons.join(" ")).toMatch(/LIVE_LOCKED/);
    expect(reasons.join(" ")).toMatch(/wallet/);
    const gate = await store.readState<{ state: string } | null>(STATE_KEYS.liveGate, null);
    expect(gate?.state ?? "LIVE_LOCKED").toBe("LIVE_LOCKED");
  });

  it("emergency stop locks live immediately; release needs the password", async () => {
    expect((await app.inject({ method: "POST", url: "/api/emergency-stop", headers: { ...H, cookie }, payload: { reason: "test" } })).statusCode).toBe(200);
    expect((await store.readState<{ active: boolean }>(STATE_KEYS.emergency, { active: false })).active).toBe(true);
    expect((await store.readState<{ state: string }>(STATE_KEYS.liveGate, { state: "" })).state).toBe("LIVE_LOCKED");
    expect((await app.inject({ method: "POST", url: "/api/emergency-release", headers: { ...H, cookie }, payload: { password: "nope-nope-nope" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/emergency-release", headers: { ...H, cookie }, payload: { password: "correct-horse-battery" } })).statusCode).toBe(200);
    expect((await store.readState<{ active: boolean }>(STATE_KEYS.emergency, { active: true })).active).toBe(false);
  });

  it("raising a risk limit needs the password; lowering does not; invalid values are rejected", async () => {
    const up = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...H, cookie }, payload: { patch: { capital: { maxTradeEur: 9 } } } });
    expect(up.statusCode).toBe(403);
    const down = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...H, cookie }, payload: { patch: { capital: { maxTradeEur: 4 } } } });
    expect(down.statusCode).toBe(200);
    const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...H, cookie }, payload: { patch: { capital: { maxTradeEur: -1 } } } });
    expect(bad.statusCode).toBe(400);
    const level = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...H, cookie }, payload: { patch: { risk: { liveLevel: 3 } }, password: "correct-horse-battery" } });
    expect(level.statusCode).toBe(409);
    const audit = await db.one<{ n: string }>("SELECT count(*)::text AS n FROM settings_audit WHERE actor = 'user:tester'");
    expect(Number(audit?.n)).toBe(1);
  });

  it("level-up is refused without live evidence", async () => {
    const r = await app.inject({ method: "POST", url: "/api/live/level", headers: { ...H, cookie }, payload: { level: 2, password: "correct-horse-battery" } });
    expect(r.statusCode).toBe(409);
  });

  it("tax export carries the disclaimer; wallet endpoint never returns key material", async () => {
    const csv = await app.inject({ method: "GET", url: "/api/tax/export?format=csv", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\n")[0]).toMatch(/Keine Steuerberatung/);
    const w = await app.inject({ method: "GET", url: "/api/wallet", headers: { cookie } });
    expect(w.body).not.toMatch(/secret|privateKey|keystore|passphrase/i);
  });

  it("logout invalidates the session", async () => {
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { "x-requested-with": "solarbiter", cookie } });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/status", headers: { cookie } })).statusCode).toBe(401);
  });
});
