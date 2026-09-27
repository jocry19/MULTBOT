import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcManager } from "@solarbiter/solana";

/**
 * Test support: mainnet pool accounts captured at one slot, served by a fake RPC.
 * (Only imported by tests.)
 */
export interface FixtureAccount {
  address: string;
  owner: string;
  data: string;
}

export function loadPoolFixtures(): { slot: number; accounts: Record<string, FixtureAccount> } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(fs.readFileSync(path.join(here, "__fixtures__/pool-accounts.json"), "utf8")) as { slot: number; accounts: Record<string, FixtureAccount> };
}

/** RpcManager stand-in answering getMultipleAccountsWithSlot from fixture accounts (by address). */
export function fixtureRpc(accounts: FixtureAccount[], slot = 1): RpcManager {
  const byAddress = new Map(accounts.map((a) => [a.address, a]));
  return {
    async getMultipleAccountsWithSlot(addresses: string[]) {
      return {
        slot,
        accounts: addresses.map((a) => {
          const f = byAddress.get(a);
          return f ? { lamports: 0, owner: f.owner, data: [f.data, "base64"] as [string, string], executable: false, rentEpoch: 0 } : null;
        }),
      };
    },
  } as unknown as RpcManager;
}

/** Buffers by address, as PoolStateService hands them to adapters. */
export function accountBuffers(accounts: FixtureAccount[]): Map<string, Buffer> {
  return new Map(accounts.map((a) => [a.address, Buffer.from(a.data, "base64")]));
}
