import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../db/database.js";
import { ensurePartitions } from "../../db/migrate.js";
import { silentLogger } from "../../core/logger.js";
import { createTestDatabase } from "../../test/db.js";
import type { AccountInfo, RpcManager } from "../solana/rpcManager.js";
import { PUMP_AMM_PROGRAM_ID, WSOL_MINT } from "../pumpfun/constants.js";
import { normalizeEvents } from "../pumpfun/normalize.js";
import { PoolRegistry, parsePoolAccount } from "./poolRegistry.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const key = (seed: number) => bs58.encode(Buffer.alloc(32, seed));

function poolAccount(baseMint: string, quoteMint: string): AccountInfo {
  const data = Buffer.alloc(211);
  bs58.decode(baseMint).forEach((b, i) => (data[43 + i] = b));
  bs58.decode(quoteMint).forEach((b, i) => (data[75 + i] = b));
  return { lamports: 1, owner: PUMP_AMM_PROGRAM_ID, data: [data.toString("base64"), "base64"], executable: false, rentEpoch: 0 };
}

function fakeRpc(accounts: Record<string, AccountInfo>): RpcManager {
  return {
    getMultipleAccounts: async (addrs: string[]) => addrs.map((a) => accounts[a] ?? null),
    getAccountInfo: async (a: string) => accounts[a] ?? null,
    getTokenSupply: async () => ({ amount: "0", decimals: 6 }),
  } as unknown as RpcManager;
}

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe("pool quote mints", () => {
  it("parses base and quote mint from a pool account", () => {
    const acct = poolAccount(key(1), USDC);
    expect(parsePoolAccount("p", Buffer.from(acct.data[0], "base64"))).toEqual({ pool: "p", baseMint: key(1), quoteMint: USDC });
  });

  it("never preloads a pool as SOL-quoted without a recorded quote, and purges non-SOL market data", async () => {
    const solMint = key(1);
    const usdcMint = key(2);
    const solPool = key(11);
    const usdcPool = key(12);
    const trader = key(21);
    const ts = new Date("2026-02-01T10:00:00Z");
    await ensurePartitions(db, "market_trades", ts, ts);
    await db.query(
      `INSERT INTO tokens (mint, available_at, source, amm_pool, amm_quote_mint, decimals) VALUES
         ($1, now(), 'discovered', $2, $5, 6), ($3, now(), 'discovered', $4, NULL, NULL)`,
      [solMint, solPool, usdcMint, usdcPool, WSOL_MINT],
    );
    // polluted data: USDC amounts that were read as lamports
    await db.query(
      `INSERT INTO market_trades (signature, event_index, slot, ts, available_at, mint, venue, pool, trader, is_buy, sol_amount, token_amount, price_sol, source)
       VALUES ('s1', 0, 1, $1, $1, $2, 'pump_amm', $3, $4, true, 500000000000, 1000000, 0.5, 'live'),
              ('s2', 0, 2, $1, $1, $5, 'pump_amm', $6, $4, true, 100000000, 1000000, 0.0001, 'live')`,
      [ts, usdcMint, usdcPool, trader, solMint, solPool],
    );
    await db.query(
      `INSERT INTO wallets (address, first_seen_at, last_seen_at, trade_count, buy_count, tokens_traded, volume_sol, closed_positions, winning_positions, realized_pnl_sol, sum_return, sum_return_sq)
       VALUES ($1, $2, $2, 2, 2, 2, 500.1, 1, 1, 400, 0.8, 0.64)`,
      [trader, ts],
    );
    await db.query(
      `INSERT INTO wallet_positions (address, mint, cost_sol, proceeds_sol, buys, sells, first_buy_at, last_trade_at, closed_at, realized_pnl_sol)
       VALUES ($1, $2, 500, 900, 1, 1, $3, $3, $3, 400)`,
      [trader, usdcMint, ts],
    );

    const reg = new PoolRegistry(fakeRpc({ [usdcPool]: poolAccount(usdcMint, USDC), [solPool]: poolAccount(solMint, WSOL_MINT) }), db, silentLogger());
    await reg.loadFromDb();

    expect(reg.lookup(solPool)?.quoteMint).toBe(WSOL_MINT);
    expect(reg.lookup(usdcPool)?.quoteMint).toBe(USDC);
    expect(reg.rejectedMints.has(usdcMint)).toBe(true);
    const tok = await db.one<{ amm_quote_mint: string }>("SELECT amm_quote_mint FROM tokens WHERE mint = $1", [usdcMint]);
    expect(tok?.amm_quote_mint).toBe(USDC);

    const left = await db.many<{ mint: string }>("SELECT mint FROM market_trades");
    expect(left.map((r) => r.mint)).toEqual([solMint]);
    const w = await db.one<{ trade_count: number; volume_sol: number; closed_positions: number; realized_pnl_sol: number; tokens_traded: number }>(
      "SELECT trade_count, volume_sol, closed_positions, realized_pnl_sol, tokens_traded FROM wallets WHERE address = $1",
      [trader],
    );
    expect(w?.trade_count).toBe(1);
    expect(w?.volume_sol).toBeCloseTo(0.1, 9);
    expect(w?.closed_positions).toBe(0);
    expect(w?.realized_pnl_sol).toBeCloseTo(0, 9);
    expect(w?.tokens_traded).toBe(1);
  });

  it("drops trades of a non-SOL pool during normalisation", () => {
    const reg = new PoolRegistry(null, null, silentLogger());
    reg.add({ pool: "P", baseMint: key(3), quoteMint: USDC, baseDecimals: 6 });
    const res = normalizeEvents(
      [
        {
          index: 0,
          event: {
            name: "BuyEvent",
            data: {
              timestamp: 1_770_000_000n,
              pool: "P",
              base_amount_out: 1_000_000n,
              quote_amount_in: 5_000_000n,
              pool_base_token_reserves: 1_000_000_000n,
              pool_quote_token_reserves: 5_000_000_000n,
            },
          },
        },
      ] as never,
      { signature: "x", slot: 1, availableAt: 0, source: "live", lookupPool: reg.lookup },
    );
    expect(res.events).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });
});
