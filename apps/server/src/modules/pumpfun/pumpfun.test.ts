import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeEvent, eventDiscriminator } from "./events.js";
import { parseLogs } from "./logParser.js";
import { normalizeEvents, type PoolInfo } from "./normalize.js";
import {
  applyCurveTrade,
  curvePriceSol,
  quoteCurveBuy,
  quoteCurveSell,
  quotePoolBuy,
  quotePoolSell,
  type CurveState,
} from "./curve.js";
import {
  INITIAL_REAL_TOKEN_RESERVES,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  PUMP_PROGRAM_ID,
  PUMP_TOKEN_TOTAL_SUPPLY,
  WSOL_MINT,
} from "./constants.js";

const fixtures = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/mainnet-events.json"), "utf8"),
) as Record<string, { signature: string; slot: number; blockTime: number; logMessages: string[]; poolAccount?: string; postTokenBalances?: { mint: string; owner: string; uiTokenAmount: { amount: string } }[] }>;

function poolFromAccount(pool: string, base64: string): PoolInfo {
  const data = Buffer.from(base64, "base64");
  return {
    pool,
    baseMint: bs58.encode(data.subarray(43, 75)),
    quoteMint: bs58.encode(data.subarray(75, 107)),
    baseDecimals: 6,
  };
}

/** Tiny borsh writer for synthetic events. */
class W {
  parts: Buffer[] = [];
  u64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.parts.push(b);
    return this;
  }
  i64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    this.parts.push(b);
    return this;
  }
  bool(v: boolean) {
    this.parts.push(Buffer.from([v ? 1 : 0]));
    return this;
  }
  pubkey(s: string) {
    this.parts.push(Buffer.from(bs58.decode(s)));
    return this;
  }
  str(s: string) {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    this.parts.push(len, b);
    return this;
  }
  build(name: string) {
    return Buffer.concat([Buffer.from(eventDiscriminator(name)), ...this.parts]);
  }
}

const MINT = "A38cJxBe8WAoeAMMCSqs9Ve8PBQ5tbYZtLFYszzBpump";
const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("event discriminators", () => {
  it("match the published IDL values", () => {
    expect([...eventDiscriminator("TradeEvent")]).toEqual([189, 219, 127, 211, 78, 230, 97, 238]);
    expect([...eventDiscriminator("CreateEvent")]).toEqual([27, 114, 169, 77, 222, 235, 99, 118]);
    expect([...eventDiscriminator("CompleteEvent")]).toEqual([95, 114, 97, 156, 212, 46, 152, 8]);
  });
});

describe("decoding real mainnet transactions", () => {
  for (const [kind, fx] of Object.entries(fixtures)) {
    it(`${kind}: decodes all known fields without leftover bytes`, () => {
      const res = parseLogs(fx.logMessages);
      expect(res.errors).toEqual([]);
      expect(res.events.length).toBeGreaterThan(0);
      for (const e of res.events) expect(e.event.unknownTrailingBytes).toBe(0);
    });
  }

  it("normalises a bonding-curve buy with post-trade reserves and fees", () => {
    const fx = fixtures.TradeEventBuy!;
    const parsed = parseLogs(fx.logMessages);
    const norm = normalizeEvents(parsed.events, { signature: fx.signature, slot: fx.slot, availableAt: 1, source: "backfill", lookupPool: () => undefined });
    const trade = norm.events.find((e) => e.kind === "trade")?.data as import("../../domain/market.js").MarketTrade;
    expect(trade.venue).toBe("pump_curve");
    expect(trade.isBuy).toBe(true);
    expect(trade.solAmount > 0n).toBe(true);
    expect(trade.feeLamports > 0n).toBe(true);
    expect(trade.feeBps).toBeGreaterThan(0);
    expect(trade.feeBps).toBeLessThan(300);
    expect(Math.abs(trade.ts / 1000 - fx.blockTime)).toBeLessThan(120);
    expect(trade.priceSol).toBeCloseTo(curvePriceSol({ virtualSolReserves: trade.virtualSolReserves!, virtualTokenReserves: trade.virtualTokenReserves! }), 12);
  });

  it("normalises a token creation", () => {
    const fx = fixtures.CreateEvent!;
    const parsed = parseLogs(fx.logMessages);
    const norm = normalizeEvents(parsed.events, { signature: fx.signature, slot: fx.slot, availableAt: 1, source: "backfill", lookupPool: () => undefined });
    const create = norm.events.find((e) => e.kind === "create")?.data as import("../../domain/market.js").TokenCreated;
    expect(create.mint.length).toBeGreaterThan(30);
    expect(create.tokenTotalSupply).toBe(PUMP_TOKEN_TOTAL_SUPPLY);
    expect(create.virtualTokenReserves > 0n).toBe(true);
    expect(typeof create.isMayhemMode).toBe("boolean");
  });

  for (const kind of ["BuyEvent", "SellEvent"] as const) {
    it(`PumpSwap ${kind}: derived post-trade reserves equal the pool vault balances`, () => {
      const fx = fixtures[kind]!;
      const parsed = parseLogs(fx.logMessages);
      const poolAddr = String(parsed.events.find((e) => e.event.name === kind)?.event.data.pool);
      const info = poolFromAccount(poolAddr, fx.poolAccount!);
      const unresolved = normalizeEvents(parsed.events, { signature: fx.signature, slot: fx.slot, availableAt: 1, source: "backfill", lookupPool: () => undefined });
      expect(unresolved.unresolvedPools).toContain(poolAddr);
      const norm = normalizeEvents(parsed.events, { signature: fx.signature, slot: fx.slot, availableAt: 1, source: "backfill", lookupPool: (p) => (p === poolAddr ? info : undefined) });
      const trades = norm.events.filter((e) => e.kind === "trade").map((e) => e.data as import("../../domain/market.js").MarketTrade);
      if (info.quoteMint !== WSOL_MINT) {
        expect(trades).toHaveLength(0);
        return;
      }
      const t = trades[0]!;
      expect(t.venue).toBe("pump_amm");
      expect(t.isBuy).toBe(kind === "BuyEvent");
      const baseVault = fx.postTokenBalances?.find((b) => b.mint === info.baseMint && b.owner === poolAddr);
      const quoteVault = fx.postTokenBalances?.find((b) => b.mint === WSOL_MINT && b.owner === poolAddr);
      // single-swap transactions: vault balance after the tx equals derived reserves
      if (trades.length === 1 && baseVault && quoteVault) {
        expect(BigInt(baseVault.uiTokenAmount.amount)).toBe(t.realTokenReserves);
        expect(BigInt(quoteVault.uiTokenAmount.amount)).toBe(t.realSolReserves);
      }
    });
  }
});

describe("prefix-tolerant decoding", () => {
  it("decodes an old TradeEvent layout (10 fields only)", () => {
    const payload = new W()
      .pubkey(MINT)
      .u64(1_000_000_000n)
      .u64(35_000_000_000_000n)
      .bool(true)
      .pubkey(USER)
      .i64(1_700_000_000n)
      .u64(31_000_000_000n)
      .u64(1_038_000_000_000_000n)
      .u64(1_000_000_000n)
      .u64(758_100_000_000_000n)
      .build("TradeEvent");
    const e = decodeEvent("pump", payload)!;
    expect(e.name).toBe("TradeEvent");
    expect(e.data.sol_amount).toBe(1_000_000_000n);
    expect(e.data.fee).toBeUndefined();
    expect(e.unknownTrailingBytes).toBe(0);
  });

  it("rejects an event missing required fields", () => {
    const payload = new W().pubkey(MINT).u64(1n).build("TradeEvent");
    expect(() => decodeEvent("pump", payload)).toThrow(/required/);
  });

  it("reports unknown trailing bytes from a newer layout", () => {
    const payload = new W().pubkey(USER).pubkey(MINT).pubkey(USER).i64(1n).pubkey(WSOL_MINT).u64(42n).build("CompleteEvent");
    const e = decodeEvent("pump", payload)!;
    expect(e.unknownTrailingBytes).toBe(8);
  });

  it("ignores events of a different program / unknown discriminators", () => {
    expect(decodeEvent("pump", Buffer.alloc(40))).toBeNull();
    const payload = new W().pubkey(USER).build("CompleteEvent");
    expect(decodeEvent("pump_amm", payload)).toBeNull();
  });

  it("attributes Program data to the innermost program only", () => {
    const tradeB64 = new W()
      .pubkey(MINT).u64(1_000_000n).u64(1_000n).bool(true).pubkey(USER).i64(1n)
      .u64(INITIAL_VIRTUAL_SOL_RESERVES).u64(INITIAL_VIRTUAL_TOKEN_RESERVES).u64(0n).u64(INITIAL_REAL_TOKEN_RESERVES)
      .build("TradeEvent").toString("base64");
    const logs = [
      "Program SomeOtherProgram1111111111111111111111111 invoke [1]",
      `Program data: ${tradeB64}`,
      `Program ${PUMP_PROGRAM_ID} invoke [2]`,
      `Program data: ${tradeB64}`,
      `Program ${PUMP_PROGRAM_ID} success`,
      `Program data: ${tradeB64}`,
      "Program SomeOtherProgram1111111111111111111111111 success",
    ];
    expect(parseLogs(logs).events).toHaveLength(1);
  });

  it("flags truncated logs", () => {
    expect(parseLogs(["Log truncated"]).truncated).toBe(true);
  });
});

describe("bonding curve math", () => {
  const fresh: CurveState = {
    virtualSolReserves: INITIAL_VIRTUAL_SOL_RESERVES,
    virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    realSolReserves: 0n,
    realTokenReserves: INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: PUMP_TOKEN_TOTAL_SUPPLY,
    complete: false,
  };

  it("initial price is ~2.8e-8 SOL per token (≈28 SOL market cap)", () => {
    expect(curvePriceSol(fresh)).toBeCloseTo(30 / 1_073_000_000, 15);
  });

  it("buy quote respects constant product and fees", () => {
    const q = quoteCurveBuy(fresh, 10_000_000n, 100); // 0.01 SOL, 1% fee
    expect(q.solSpent).toBeLessThanOrEqual(10_000_000n);
    expect(q.solIntoCurve).toBe((10_000_000n * 10_000n) / 10_100n);
    // k non-decreasing
    const k0 = fresh.virtualSolReserves * fresh.virtualTokenReserves;
    const k1 = (fresh.virtualSolReserves + q.solIntoCurve) * (fresh.virtualTokenReserves - q.tokensOut);
    expect(k1 >= k0).toBe(true);
    expect(q.priceImpact).toBeGreaterThan(0);
    expect(q.priceAfter).toBeGreaterThan(q.spotPriceBefore);
  });

  it("round trip buy → sell loses exactly fees + rounding (no free money)", () => {
    const q = quoteCurveBuy(fresh, 100_000_000n, 125);
    const after = applyCurveTrade(fresh, true, q.solIntoCurve, q.tokensOut);
    const s = quoteCurveSell(after, q.tokensOut, 125);
    expect(s.solOutNet).toBeLessThan(q.solSpent);
    const loss = Number(q.solSpent - s.solOutNet) / Number(q.solSpent);
    expect(loss).toBeGreaterThan(0.02); // two fees of 1.25%
    expect(loss).toBeLessThan(0.03);
  });

  it("caps buys at the real token reserves (partial fill near completion)", () => {
    const nearlyDone: CurveState = { ...fresh, realTokenReserves: 1_000_000n };
    const q = quoteCurveBuy(nearlyDone, 5_000_000_000n, 100);
    expect(q.capped).toBe(true);
    expect(q.tokensOut).toBe(1_000_000n);
    expect(q.solSpent).toBeLessThan(5_000_000_000n);
  });

  it("sell cannot drain more than the real SOL reserves", () => {
    const s = quoteCurveSell({ ...fresh, realSolReserves: 1_000n }, 100_000_000_000_000n, 100);
    expect(s.capped).toBe(true);
    expect(s.solOutGross).toBe(1_000n);
  });

  it("pool buy/sell quotes behave like constant product", () => {
    const pool = { baseReserves: 200_000_000_000_000n, quoteReserves: 85_000_000_000n, baseDecimals: 6, baseSupply: PUMP_TOKEN_TOTAL_SUPPLY };
    const b = quotePoolBuy(pool, 10_000_000n, 125);
    expect(b.tokensOut > 0n).toBe(true);
    const s = quotePoolSell(pool, b.tokensOut, 125);
    expect(s.solOutNet).toBeLessThan(10_000_000n);
  });
});
