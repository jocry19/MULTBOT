import { describe, expect, it } from "vitest";
import { silentLogger } from "../../core/logger.js";
import { RpcError, RpcManager } from "./rpcManager.js";
import type { RpcEndpointConfig } from "../../core/config.js";

type Handler = (method: string, params: unknown[]) => { status?: number; body?: unknown };

function fakeFetch(handlers: Record<string, Handler>, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push(`${host}:${req.method}`);
    const h = handlers[host];
    if (!h) throw new TypeError("fetch failed");
    const r = h(req.method, req.params);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const endpoints: RpcEndpointConfig[] = [
  { name: "a", kind: "helius", httpUrl: "https://a.example", wsUrl: null, rps: 1000 },
  { name: "b", kind: "generic", httpUrl: "https://b.example", wsUrl: null, rps: 1000 },
];

const ok = (result: unknown) => ({ body: { jsonrpc: "2.0", id: 1, result } });

describe("RpcManager", () => {
  it("fails over to the next endpoint on HTTP 5xx", async () => {
    const calls: string[] = [];
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch({ "a.example": () => ({ status: 503 }), "b.example": () => ok(123) }, calls),
    });
    expect(await rpc.call<number>("getSlot")).toBe(123);
    expect(calls).toEqual(["a.example:getSlot", "b.example:getSlot"]);
  });

  it("treats 429 as transient and fails over", async () => {
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch({ "a.example": () => ({ status: 429 }), "b.example": () => ok(7) }),
    });
    expect(await rpc.call<number>("getSlot")).toBe(7);
  });

  it("does not retry deterministic RPC errors", async () => {
    const calls: string[] = [];
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch(
        {
          "a.example": () => ({ body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } } }),
          "b.example": () => ok(1),
        },
        calls,
      ),
    });
    await expect(rpc.call("getBalance", ["x"])).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(1);
  });

  it("bounds retries when everything fails", async () => {
    const calls: string[] = [];
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch({ "a.example": () => ({ status: 500 }), "b.example": () => ({ status: 500 }) }, calls),
    });
    await expect(rpc.call("getSlot", [], { attempts: 3 })).rejects.toThrow(/HTTP 500/);
    expect(calls.length).toBe(3);
  });

  it("tracks slots, lag and endpoint status", async () => {
    const rpc = new RpcManager(endpoints, silentLogger(), {
      maxSlotLag: 10,
      fetchImpl: fakeFetch({ "a.example": () => ok(1000), "b.example": () => ok(900) }),
    });
    await rpc.checkHealth();
    const h = rpc.endpointHealth();
    expect(h.find((e) => e.name === "a")?.status).toBe("CONNECTED");
    expect(h.find((e) => e.name === "b")?.status).toBe("DEGRADED");
    expect(h.find((e) => e.name === "b")?.slotLag).toBe(100);
    expect(rpc.currentSlot).toBe(1000);
    expect(h[0]?.url).toBe("https://a.example");
  });

  it("marks an endpoint unhealthy when the network fails", async () => {
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch({ "b.example": () => ok(5) }),
    });
    await rpc.checkHealth();
    expect(rpc.endpointHealth().find((e) => e.name === "a")?.status).toBe("DISCONNECTED");
    expect(rpc.componentStatus()).toBe("CONNECTED");
  });

  it("cross-verifies critical reads", async () => {
    const rpc = new RpcManager(endpoints, silentLogger(), {
      fetchImpl: fakeFetch({ "a.example": () => ok({ value: 100 }), "b.example": () => ok({ value: 999 }) }),
    });
    const r = await rpc.callVerified<{ value: number }>("getBalance", ["x"], (x, y) => x.value === y.value);
    expect(r.verified).toBe(false);
    expect(r.mismatch?.secondary.value).toBe(999);
  });
});
