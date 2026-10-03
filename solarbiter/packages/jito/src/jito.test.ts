import { describe, expect, it } from "vitest";
import { JitoExecutionAdapter } from "./adapter.js";
import { JitoClient, MIN_JITO_TIP_LAMPORTS, chooseTip, tipInstruction } from "./client.js";

const TIPS = ["3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"];
const floorJson = [{ time: "x", landed_tips_25th_percentile: 2.358e-6, landed_tips_50th_percentile: 2.358e-6, landed_tips_75th_percentile: 0.000024533, landed_tips_95th_percentile: 0.000105862, landed_tips_99th_percentile: 0.00075, ema_landed_tips_50th_percentile: 4.2e-6 }];

function fake(handler: (method: string, params: unknown[], url: string) => unknown, calls: { method: string; params: unknown[]; headers: Record<string, string> }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes("tip_floor")) return new Response(JSON.stringify(floorJson), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: handler(body.method, body.params, String(url)) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Jito", () => {
  it("tip: landed percentile, Jito minimum, configured max and share-of-profit cap", async () => {
    const c = new JitoClient({ blockEngineUrl: "https://be.test", tipFloorUrl: "https://bundles.test/tip_floor", fetchImpl: fake(() => null) });
    const f = await c.refreshTipFloor();
    expect(f.p50).toBe(2_358);
    expect(f.p75).toBe(24_533);
    expect(chooseTip(f, { percentile: 50, maxTipLamports: 200_000, expectedProfitLamports: 1_000_000n, maxShareOfProfit: 0.5 })).toBe(2_358n);
    expect(chooseTip(f, { percentile: 75, maxTipLamports: 10_000, expectedProfitLamports: 1_000_000n, maxShareOfProfit: 0.5 })).toBe(10_000n);
    expect(chooseTip(f, { percentile: 75, maxTipLamports: 200_000, expectedProfitLamports: 20_000n, maxShareOfProfit: 0.5 })).toBe(10_000n);
    expect(chooseTip(f, { percentile: 50, maxTipLamports: 200_000, expectedProfitLamports: 0n, maxShareOfProfit: 0.5 })).toBe(BigInt(MIN_JITO_TIP_LAMPORTS));
    expect(() => tipInstruction(TIPS[0]!, TIPS, 999)).toThrow();
    const ix = tipInstruction(TIPS[0]!, TIPS, 5_000, () => 0.9);
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(TIPS[1]);
  });

  it("sendBundle uses base64 encoding, spaces requests (1 rps) and sends the auth header", async () => {
    const calls: { method: string; params: unknown[]; headers: Record<string, string> }[] = [];
    let t = 0;
    const slept: number[] = [];
    const c = new JitoClient({
      blockEngineUrl: "https://be.test/",
      tipFloorUrl: "x",
      auth: "uuid-1",
      fetchImpl: fake((m) => (m === "getTipAccounts" ? TIPS : "bundle-123"), calls),
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    t = 5_000;
    expect(await c.getTipAccounts()).toEqual(TIPS);
    expect(await c.sendBundle(["AAA="])).toBe("bundle-123");
    expect(calls[1]).toMatchObject({ method: "sendBundle", params: [["AAA="], { encoding: "base64" }] });
    expect(calls[1]!.headers["x-jito-auth"]).toBe("uuid-1");
    expect(slept).toEqual([1_000]);
    await expect(c.sendBundle([])).rejects.toThrow();
    await expect(c.sendBundle(["a", "b", "c", "d", "e", "f"])).rejects.toThrow();
  });

  it("waits for Landed / Failed and times out otherwise", async () => {
    let t = 0;
    const sleep = async (ms: number) => {
      t += ms;
    };
    let n = 0;
    const c = new JitoClient({ blockEngineUrl: "https://be.test", tipFloorUrl: "x", minIntervalMs: 0, now: () => t, sleep, fetchImpl: fake(() => ({ context: { slot: 1 }, value: [{ bundle_id: "b", status: ++n < 3 ? "Pending" : "Landed", landed_slot: n < 3 ? null : 99 }] })) });
    const a = new JitoExecutionAdapter(c, { now: () => t, sleep });
    expect(await a.waitForResult("b", 10_000, 500)).toMatchObject({ state: "Landed", landedSlot: 99, polls: 3 });
    const c2 = new JitoClient({ blockEngineUrl: "https://be.test", tipFloorUrl: "x", minIntervalMs: 0, now: () => t, sleep, fetchImpl: fake(() => ({ context: { slot: 1 }, value: [{ bundle_id: "b", status: "Pending", landed_slot: null }] })) });
    expect((await new JitoExecutionAdapter(c2, { now: () => t, sleep }).waitForResult("b", 3_000, 1_000)).state).toBe("Timeout");
  });
});
