import bs58 from "bs58";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { USDC_MINT } from "@solarbiter/shared";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./mint.js";
import type { RpcManager } from "./rpcManager.js";
import { TokenRegistry } from "./tokenRegistry.js";

const AUTH = bs58.encode(Buffer.alloc(32, 7));

function mintData(o: { decimals: number; mintAuth?: string; freeze?: string }): string {
  const d = Buffer.alloc(82);
  if (o.mintAuth) {
    d.writeUInt32LE(1, 0);
    Buffer.from(bs58.decode(o.mintAuth)).copy(d, 4);
  }
  d.writeBigUInt64LE(1_000_000n, 36);
  d[44] = o.decimals;
  d[45] = 1;
  if (o.freeze) {
    d.writeUInt32LE(1, 46);
    Buffer.from(bs58.decode(o.freeze)).copy(d, 50);
  }
  return d.toString("base64");
}

function rpc(accounts: Record<string, { owner: string; data: string } | null>): RpcManager {
  return {
    async getMultipleAccountsWithSlot(addresses: string[]) {
      return { slot: 1, accounts: addresses.map((a) => (accounts[a] ? { lamports: 1, owner: accounts[a]!.owner, data: [accounts[a]!.data, "base64"], executable: false, rentEpoch: 0 } : null)) };
    },
  } as unknown as RpcManager;
}

const log = pino({ level: "silent" });
const PLAIN = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const FROZEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const T22 = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const MISSING = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";

describe("TokenRegistry", () => {
  const chain = rpc({
    [USDC_MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6, mintAuth: AUTH, freeze: AUTH }) },
    [PLAIN]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [FROZEN]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 5, freeze: AUTH }) },
    [T22]: { owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [MISSING]: null,
  });
  const list = [
    { mint: USDC_MINT, symbol: "USDC", name: "USD Coin", trusted: true },
    { mint: PLAIN, symbol: "JUP", name: "Jupiter" },
    { mint: FROZEN, symbol: "FRZ", name: "Freezable" },
    { mint: T22, symbol: "T22", name: "Token-2022" },
    { mint: MISSING, symbol: "GONE", name: "Missing" },
  ];

  it("reads decimals/authorities on-chain and applies the conservative policy", async () => {
    const reg = new TokenRegistry(chain, log);
    await reg.load(list, { allowlist: [], denylist: [] });
    expect(reg.decimals(PLAIN)).toBe(6);
    expect(reg.decimals(FROZEN)).toBe(5);
    expect(reg.decimals(MISSING)).toBeUndefined();
    expect(reg.isTradable(USDC_MINT)).toBe(true); // trusted issuer: freeze authority expected
    expect(reg.get(USDC_MINT)!.safetyReasons).toContain("note: mint authority present");
    expect(reg.isTradable(PLAIN)).toBe(true);
    expect(reg.isTradable(FROZEN)).toBe(false);
    expect(reg.isTradable(T22)).toBe(false);
    expect(reg.isTradable(MISSING)).toBe(false);
    expect(reg.safe().map((t) => t.symbol).sort()).toEqual(["JUP", "USDC"]);
  });

  it("allowlist unlocks freeze-authority / Token-2022 mints, denylist always wins", async () => {
    const reg = new TokenRegistry(chain, log);
    await reg.load(list, { allowlist: [FROZEN, T22], denylist: [PLAIN] });
    expect(reg.isTradable(FROZEN)).toBe(true);
    expect(reg.isTradable(T22)).toBe(true);
    expect(reg.isTradable(PLAIN)).toBe(false);
    reg.applyPolicy({ allowlist: [], denylist: [USDC_MINT] });
    expect(reg.isTradable(USDC_MINT)).toBe(false);
    expect(reg.isTradable(FROZEN)).toBe(false);
  });
});
