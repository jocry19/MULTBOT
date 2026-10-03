/**
 * Verifies the Pump/PumpSwap event decoder against live mainnet transactions.
 *
 * For recent transactions of both programs it decodes the events and cross-checks them against the
 * transaction's own balance changes:
 *   - bonding curve: curve account lamports after the tx == rent + real_sol_reserves (post-trade state)
 *   - bonding curve: trader SOL change ≈ −(sol_amount + fees) for buys
 *   - PumpSwap: pool vault balances after the tx == reserves derived by the normaliser
 *
 * Run after Pump program upgrades:  pnpm --filter @multbot/server exec tsx --conditions=source src/cli/verify-decoder.ts
 */
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { RpcManager, type RpcTransaction } from "../modules/solana/rpcManager.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT } from "../modules/pumpfun/constants.js";
import { parseTransaction } from "../modules/pumpfun/logParser.js";
import { normalizeEvents, type PoolInfo } from "../modules/pumpfun/normalize.js";

const config = loadConfig();
const log = createLogger({ level: "warn" });
const rpc = new RpcManager(config.rpc.endpoints, log);

function accountKeys(tx: RpcTransaction): string[] {
  return [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
}

async function recentTxs(program: string, n: number): Promise<RpcTransaction[]> {
  const sigs = await rpc.getSignaturesForAddress(program, { limit: 40 });
  const out: RpcTransaction[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc.getTransaction(s.signature);
    if (tx) out.push(tx);
    if (out.length >= n) break;
  }
  return out;
}

let checks = 0;
let failures = 0;
const byKind = new Map<string, number>();
function check(label: string, ok: boolean, detail: unknown): void {
  checks++;
  const kind = label.split(" ").slice(1).join(" ");
  byKind.set(kind.replace(/^\w+Event /, "event "), (byKind.get(kind.replace(/^\w+Event /, "event ")) ?? 0) + 1);
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}`, detail);
  }
}

const pools = new Map<string, PoolInfo>();

async function resolvePool(pool: string): Promise<PoolInfo | undefined> {
  const info = await rpc.getAccountInfo(pool);
  if (!info) return undefined;
  const data = Buffer.from(info.data[0], "base64");
  // Pool layout: 8 disc | u8 bump | u16 index | creator 32 | base_mint 32 | quote_mint 32 | …
  const bs58 = (await import("bs58")).default;
  const baseMint = bs58.encode(data.subarray(8 + 1 + 2 + 32, 8 + 1 + 2 + 64));
  const quoteMint = bs58.encode(data.subarray(8 + 1 + 2 + 64, 8 + 1 + 2 + 96));
  const p = { pool, baseMint, quoteMint, baseDecimals: 6 };
  pools.set(pool, p);
  return p;
}

for (const tx of await recentTxs(PUMP_PROGRAM_ID, 8)) {
  const sig = tx.transaction.signatures[0] ?? "";
  const parsed = parseTransaction(tx);
  const norm = normalizeEvents(parsed.events, { signature: sig, slot: tx.slot, availableAt: Date.now(), source: "backfill", lookupPool: (p) => pools.get(p) });
  const keys = accountKeys(tx);
  for (const e of parsed.events) {
    check(`${sig} ${e.event.name} trailing bytes`, e.event.unknownTrailingBytes === 0, e.event.unknownTrailingBytes);
  }
  for (const ev of norm.events) {
    if (ev.kind !== "trade" || ev.data.venue !== "pump_curve") continue;
    const t = ev.data;
    const tradeEvent = parsed.events.find((p) => p.event.name === "TradeEvent" && p.event.data.mint === t.mint)?.event;
    const curvePda = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(t.mint).toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0].toBase58();
    const bc = keys.indexOf(curvePda);
    if (bc >= 0 && tx.meta) {
      const lamports = tx.meta.postBalances[bc] ?? 0;
      const rent = lamports - Number(t.realSolReserves ?? 0n);
      // rent of the 150-ish byte bonding curve account is ~0.0015–0.002 SOL
      check(`${sig} curve lamports = rent + real_sol_reserves (post)`, rent > 1_000_000 && rent < 3_000_000, { lamports, real: String(t.realSolReserves), rent });
    }
    const traderIdx = keys.indexOf(t.trader);
    if (traderIdx >= 0 && tx.meta && t.isBuy && traderIdx === 0) {
      const spent = (tx.meta.preBalances[0] ?? 0) - (tx.meta.postBalances[0] ?? 0) - tx.meta.fee;
      const expected = Number(t.solAmount + t.feeLamports);
      // spent also includes ATA rent, priority fee, tips → only a lower bound check
      check(`${sig} trader spent >= sol_amount + fees`, spent >= expected - 10, { spent, expected, fee: String(tradeEvent?.data.fee) });
    }
  }
}

for (const tx of await recentTxs(PUMP_AMM_PROGRAM_ID, 8)) {
  const sig = tx.transaction.signatures[0] ?? "";
  const parsed = parseTransaction(tx);
  for (const e of parsed.events) {
    const pool = e.event.data.pool;
    if (typeof pool === "string" && !pools.has(pool)) await resolvePool(pool);
    check(`${sig} ${e.event.name} trailing bytes`, e.event.unknownTrailingBytes === 0, e.event.unknownTrailingBytes);
  }
  const norm = normalizeEvents(parsed.events, { signature: sig, slot: tx.slot, availableAt: Date.now(), source: "backfill", lookupPool: (p) => pools.get(p) });
  const keys = accountKeys(tx);
  for (const ev of norm.events) {
    if (ev.kind !== "trade" || ev.data.venue !== "pump_amm") continue;
    const t = ev.data;
    const post = tx.meta?.postTokenBalances ?? [];
    const baseVault = post.find((b) => b.mint === t.mint && b.owner === t.pool);
    const quoteVault = post.find((b) => b.mint === WSOL_MINT && b.owner === t.pool);
    if (baseVault) {
      check(`${sig} AMM base reserves after`, BigInt(baseVault.uiTokenAmount.amount) === t.realTokenReserves, {
        vault: baseVault.uiTokenAmount.amount,
        derived: String(t.realTokenReserves),
        key: keys[baseVault.accountIndex],
      });
    }
    if (quoteVault) {
      check(`${sig} AMM quote reserves after`, BigInt(quoteVault.uiTokenAmount.amount) === t.realSolReserves, {
        vault: quoteVault.uiTokenAmount.amount,
        derived: String(t.realSolReserves),
      });
    }
  }
}

for (const [kind, n] of byKind) console.log(`  ${n.toString().padStart(4)} × ${kind}`);
console.log(`decoder verification: ${checks - failures}/${checks} checks passed`);
process.exitCode = failures > 0 ? 1 : 0;
