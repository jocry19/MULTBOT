import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { DexRegistry, type DexAdapter, type SwapInstructions } from "@solarbiter/dex";
import { JUPITER_PROGRAM_ID, mapQuote, verifySwapInstructions, type JupiterQuoteResponse } from "@solarbiter/jupiter";
import { Portfolio } from "@solarbiter/paper-engine";
import { RiskEngine, type RiskContext } from "@solarbiter/risk-engine";
import { DEFAULT_SETTINGS, SOL_MINT, USDC_MINT, mergeSettings, solToLamports, type Opportunity, type Quote } from "@solarbiter/shared";
import { TEST_TOKEN, makeOpportunity } from "@solarbiter/shared/testing";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, type RpcManager } from "@solarbiter/solana";
import { WalletService, associatedTokenAddress, encryptSecretKey, inspectTransaction, writeKeystore } from "@solarbiter/wallet";
import { RouteBuilder } from "./builder.js";
import { LookupTableCache, MAX_TX_BYTES, NotAtomicError, buildTransaction, composeInstructions, microLamportsPerCu, optimizedComputeUnits } from "./composer.js";
import { LiveExecutor, type ExecutionJournal } from "./liveExecutor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const jfx = (n: string) => JSON.parse(fs.readFileSync(path.join(here, "../../jupiter/src/__fixtures__", n), "utf8")) as Record<string, unknown>;
const alts = JSON.parse(fs.readFileSync(path.join(here, "__fixtures__/lookup-tables.json"), "utf8")) as Record<string, { owner: string; data: string }>;
const log = pino({ level: "silent" });
const FIXTURE_USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TIP_ACCOUNTS = ["3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"];

function fixtureLegs(): { legs: SwapInstructions[]; quotes: Quote[] } {
  const q1 = mapQuote(jfx("quote-sol-usdc-raydium.json") as JupiterQuoteResponse, { inputMint: SOL_MINT, outputMint: USDC_MINT, inputDecimals: 9, outputDecimals: 6, amount: 40_000_000n, slippageBps: 30, onlyDirectRoutes: true, priority: "final" }, "raydium", 1, 1, null);
  const q2 = mapQuote(jfx("quote-usdc-sol-whirlpool-10bps.json") as JupiterQuoteResponse, { inputMint: USDC_MINT, outputMint: SOL_MINT, inputDecimals: 6, outputDecimals: 9, amount: 2_000_000n, slippageBps: 10, onlyDirectRoutes: true, priority: "final" }, "orca", 1, 1, null);
  const l1 = verifySwapInstructions(jfx("swapix-sol-usdc-raydium.json") as never, q1, 30, false);
  const l2 = verifySwapInstructions(jfx("swapix-usdc-sol-whirlpool-ledger.json") as never, q2, 10, true);
  return { legs: [l1, l2], quotes: [q1, q2] };
}

function altRpc(): RpcManager {
  return {
    async getMultipleAccounts(addresses: string[]) {
      return addresses.map((a) => (alts[a] ? { lamports: 1, owner: alts[a]!.owner, data: [alts[a]!.data, "base64"], executable: false, rentEpoch: 0 } : null));
    },
  } as unknown as RpcManager;
}

describe("atomic composition (real Jupiter instructions)", () => {
  it("orders compute budget, legs, token ledger, cleanup and tip; fits into one v0 transaction", async () => {
    const { legs } = fixtureLegs();
    const tip = SystemProgram.transfer({ fromPubkey: new PublicKey(FIXTURE_USER), toPubkey: new PublicKey(TIP_ACCOUNTS[0]!), lamports: 5_000 });
    const ixs = composeInstructions(legs, { computeUnitLimit: 300_000, computeUnitPriceMicroLamports: 50_000, tip });
    const programs = ixs.map((i) => i.programId.toBase58());
    const ledgerIdx = ixs.findIndex((i) => i.programId.toBase58() === JUPITER_PROGRAM_ID && i.data.length === 8);
    const swapIdx = ixs.map((i, k) => (i.programId.toBase58() === JUPITER_PROGRAM_ID && i.data.length > 8 ? k : -1)).filter((k) => k >= 0);
    expect(programs.slice(0, 2)).toEqual(["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"]);
    expect(ledgerIdx).toBeGreaterThan(1);
    expect(swapIdx).toHaveLength(2);
    expect(ledgerIdx).toBeLessThan(swapIdx[0] as number); // ledger recorded before leg 1 delivers the token
    expect(programs.at(-1)).toBe("11111111111111111111111111111111"); // tip last
    expect(programs.at(-2)).toBe(TOKEN_PROGRAM_ID); // closing cleanup (unwrap)

    const tables = await new LookupTableCache(altRpc()).get(legs.flatMap((l) => l.lookupTables));
    const tx = buildTransaction(FIXTURE_USER, "11111111111111111111111111111111", ixs, tables);
    expect(tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES);
    // lookup tables shrink the transaction; an oversized route is refused as not atomic
    const plain = buildTransaction(FIXTURE_USER, "11111111111111111111111111111111", ixs, []);
    expect(tx.serialize().length).toBeLessThan(plain.serialize().length);
    const bloated = [...ixs, ...Array.from({ length: 30 }, () => SystemProgram.transfer({ fromPubkey: new PublicKey(FIXTURE_USER), toPubkey: Keypair.generate().publicKey, lamports: 1 }))];
    expect(() => buildTransaction(FIXTURE_USER, "11111111111111111111111111111111", bloated, tables)).toThrow(NotAtomicError);

    const report = inspectTransaction(tx, { wallet: FIXTURE_USER, maxPriorityFeeLamports: 200_000, maxWrapLamports: 40_000_000, tipAccounts: TIP_ACCOUNTS, maxTipLamports: 200_000 });
    expect(report.tipLamports).toBe(5_000);
    expect(report.wrapLamports).toBe(40_000_000);
    expect(report.priorityFeeLamports).toBe(15_000);
    expect(() => inspectTransaction(tx, { wallet: FIXTURE_USER, maxPriorityFeeLamports: 200_000, maxWrapLamports: 1_000, tipAccounts: TIP_ACCOUNTS, maxTipLamports: 200_000 })).toThrow(/wrapping/);
    expect(() => inspectTransaction(tx, { wallet: FIXTURE_USER, maxPriorityFeeLamports: 200_000, maxWrapLamports: 40_000_000, tipAccounts: [], maxTipLamports: 200_000 })).toThrow(/unknown address/);
    expect(() => inspectTransaction(tx, { wallet: FIXTURE_USER, maxPriorityFeeLamports: 1_000, maxWrapLamports: 40_000_000, tipAccounts: TIP_ACCOUNTS, maxTipLamports: 200_000 })).toThrow(/priority fee/);
  });

  it("refuses a closing leg without the token ledger and foreign instructions", () => {
    const { legs } = fixtureLegs();
    expect(() => composeInstructions([legs[0]!, { ...legs[1]!, tokenLedger: null }], { computeUnitLimit: 1, computeUnitPriceMicroLamports: 0, tip: null })).toThrow(/token ledger/);
    expect(() => composeInstructions([legs[0]!, { ...legs[1]!, other: [legs[1]!.swap] }], { computeUnitLimit: 1, computeUnitPriceMicroLamports: 0, tip: null })).toThrow(/extra/);
  });

  it("compute units from simulation and priority price", () => {
    expect(optimizedComputeUnits(200_000, 1_400_000)).toBe(230_000);
    expect(optimizedComputeUnits(null, 1_400_000)).toBe(1_400_000);
    expect(microLamportsPerCu(23_000n, 230_000)).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------------------------------
// LiveExecutor end-to-end with a fake chain / fake DEX (synthetic instructions for the test wallet)
// ---------------------------------------------------------------------------------------------------

function syntheticLeg(wallet: string, q: Quote, last: boolean, slippageBps: number): SwapInstructions {
  const w = { pubkey: wallet, isSigner: true, isWritable: true };
  const ata = associatedTokenAddress(wallet, q.outputMint);
  const ix = (programId: string, accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[], data: Buffer) => ({ programId, accounts, data: data.toString("base64") });
  const minOut = (q.outputAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  return {
    tokenLedger: last ? ix(JUPITER_PROGRAM_ID, [{ pubkey: ata, isSigner: false, isWritable: true }], Buffer.alloc(8, 1)) : null,
    computeBudget: [],
    setup: [ix(ASSOCIATED_TOKEN_PROGRAM_ID, [w, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: false, isWritable: false }, { pubkey: q.outputMint, isSigner: false, isWritable: false }, { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], Buffer.from([1]))],
    swap: ix(JUPITER_PROGRAM_ID, [w, { pubkey: ata, isSigner: false, isWritable: true }], Buffer.alloc(40, 2)),
    cleanup: null,
    other: [],
    lookupTables: [],
    lookupTableAddresses: {},
    minOutputAmount: minOut,
  };
}

function fakeAdapter(id: "raydium" | "orca", market: { factor: number }, wallet: () => string): DexAdapter {
  return {
    id,
    labels: [id],
    poolKinds: [],
    available: () => ({ ok: true, reason: null }),
    async getQuote(req) {
      const base = makeOpportunity().legs[id === "raydium" ? 0 : 1] as Quote;
      const out = BigInt(Math.floor((Number(base.outputAmount) * Number(req.amount) * (id === "orca" ? market.factor : 1)) / Number(base.inputAmount)));
      return { ...base, inputAmount: req.amount, outputAmount: out, minOutputAmount: (out * BigInt(10_000 - req.slippageBps)) / 10_000n, timestamp: 2_000 };
    },
    async buildSwap(req) {
      return syntheticLeg(wallet(), req.quote, req.useTokenLedger === true, req.slippageBps ?? req.quote.slippageBps);
    },
    getLiquidity: (p) => ({ pool: p.address, tvlUsd: 0, reserveA: null, reserveB: null, depth1pctA: null }),
    getFees: () => ({ feeRate: 0, source: "" }),
    validateRoute: () => ({ ok: true, reasons: [] }),
    discoverPools: async () => [],
    stateAccounts: () => [],
    decodeState: () => null,
  };
}

async function liveSetup(o: { factor?: number; simErr?: unknown; onChainErr?: unknown; delta?: number } = {}) {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-ks-"));
  const file = path.join(dir, "bot.keystore.json");
  writeKeystore(file, encryptSecretKey(kp.secretKey, "correct horse battery staple", { N: 2 ** 12, r: 8, p: 1 }));
  const sent: string[] = [];
  const pre = Number(solToLamports(16 / 120));
  const rpc = {
    async getBalance() {
      return pre;
    },
    async getTokenAccountsByOwner() {
      return [];
    },
    async getLatestBlockhash() {
      return { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 };
    },
    async getMultipleAccounts() {
      return [];
    },
    async simulateTransaction() {
      return { err: o.simErr ?? null, logs: ["Program log: ok"], accounts: [{ lamports: pre + 50_000, owner: "", data: {} }], unitsConsumed: 180_000 };
    },
    async sendTransaction(b64: string) {
      sent.push(b64);
      return "sig";
    },
    async getSignatureStatuses() {
      return [{ slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed" }];
    },
    async getTransaction() {
      return { slot: 5, blockTime: 1, meta: { err: o.onChainErr ?? null, fee: 25_000, preBalances: [pre], postBalances: [pre + (o.delta ?? 60_000)], logMessages: [] }, transaction: { signatures: ["sig"], message: { accountKeys: [wallet], recentBlockhash: "", instructions: [] } } };
    },
  } as unknown as RpcManager;
  const market = { factor: o.factor ?? 1 };
  const registry = new DexRegistry().register(fakeAdapter("raydium", market, () => wallet)).register(fakeAdapter("orca", market, () => wallet));
  const settings = mergeSettings(DEFAULT_SETTINGS, { risk: { liveLevel: 4 } });
  const walletService = new WalletService(rpc, log, { keystorePath: file, passphrase: "correct horse battery staple" });
  const journal = new Map<string, Record<string, unknown>>();
  const j: ExecutionJournal = {
    async begin(key) {
      if (journal.has(key)) return false;
      journal.set(key, { status: "STARTED" });
      return true;
    },
    async update(key, patch) {
      journal.set(key, { ...journal.get(key), ...patch });
    },
  };
  const risk = new RiskEngine();
  const builder = new RouteBuilder({ registry, rpc, jito: null, tables: new LookupTableCache(rpc), settings: () => settings });
  let t = 1_000;
  const exec = new LiveExecutor({ registry, rpc, risk, builder, wallet: walletService, jito: null, journal: j, settings: () => settings, decimals: (m) => (m === SOL_MINT ? 9 : 6), rentLocked: () => 0n, log, now: () => t, sleep: async (ms) => { t += ms; } });
  const portfolio = new Portfolio("live", BigInt(pre), () => t);
  const opp: Opportunity = makeOpportunity({ mode: "live", jitoTip: 0n, sizeEur: 4.8 });
  const ctx: RiskContext = {
    now: 1_000, mode: "live", settings, botState: "LIVE", liveGate: "LIVE_ENABLED", liveModeEnabled: true, emergencyStop: false, blockingBreakers: [], solEur: 120,
    balanceLamports: BigInt(pre), capitalEur: 16, openTrades: 0, pnlTodayEur: 0, consecutiveFailures: 0, lossStreak: 0, lastTradeSizeEur: null, lastTradeLost: false, drawdownEur: 0, expectancyEur: null,
    token: { mint: TEST_TOKEN, symbol: "JUP", name: "", decimals: 6, program: TOKEN_PROGRAM_ID, mintAuthority: null, freezeAuthority: null, allowlisted: false, denylisted: false, safe: true, safetyReasons: [] },
    liquidityDepthEur: null, viaJito: false,
  };
  const decision = risk.validate(opp, ctx);
  return { exec, opp, approval: decision.approval, decision, portfolio, sent, journal, walletService };
}

describe("LiveExecutor", () => {
  it("final check → build → simulate → guard → sign → send → confirm → realised result from chain", async () => {
    const s = await liveSetup();
    expect(s.decision.reasons).toEqual([]);
    const r = await s.exec.execute(s.opp, s.approval, s.portfolio);
    expect(r.outcome).toBe("CONFIRMED");
    expect(s.sent).toHaveLength(1);
    expect(r.signature).toBeTruthy();
    expect(r.realizedNet).toBe(60_000n);
    expect(r.computeUnitLimit).toBe(optimizedComputeUnits(180_000, 0));
    expect(s.journal.get(s.opp.id)?.status).toBe("CONFIRMED");
    expect(s.portfolio.balanceLamports).toBe(BigInt(Number(solToLamports(16 / 120)) + 60_000));
    // the private key never appears in the record
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/secret/i);
  });

  it("idempotency: the same opportunity is never executed twice", async () => {
    const s = await liveSetup();
    await s.exec.execute(s.opp, s.approval, s.portfolio);
    const r2 = await s.exec.execute(s.opp, s.approval, s.portfolio);
    expect(r2.outcome).toBe("CANCELLED");
    expect(s.sent).toHaveLength(1);
  });

  it("cancels when the edge vanished at the final check (nothing is sent)", async () => {
    const s = await liveSetup({ factor: 0.997 });
    const r = await s.exec.execute(s.opp, s.approval, s.portfolio);
    expect(r.outcome).toBe("CANCELLED");
    expect(r.reason).toMatch(/edge vanished|guard/);
    expect(s.sent).toHaveLength(0);
    expect(s.portfolio.openTrades).toBe(0);
  });

  it("cancels on a failing simulation (nothing is signed or sent)", async () => {
    const s = await liveSetup({ simErr: { InstructionError: [3, { Custom: 6001 }] } });
    const r = await s.exec.execute(s.opp, s.approval, s.portfolio);
    expect(r.outcome).toBe("CANCELLED");
    expect(r.reason).toMatch(/SIMULATION_FAILED/);
    expect(s.sent).toHaveLength(0);
  });

  it("records an on-chain failure with the fees actually lost", async () => {
    const s = await liveSetup({ onChainErr: { InstructionError: [5, { Custom: 6001 }] }, delta: -25_000 });
    const r = await s.exec.execute(s.opp, s.approval, s.portfolio);
    expect(r.outcome).toBe("FAILED");
    expect(r.realizedNet).toBe(-25_000n);
    expect(s.portfolio.consecutiveFailures).toBe(1);
  });

  it("refuses without approval and never runs paper opportunities", async () => {
    const s = await liveSetup();
    expect((await s.exec.execute(s.opp, null, s.portfolio)).outcome).toBe("CANCELLED");
    await expect(s.exec.execute({ ...s.opp, mode: "paper" }, s.approval, s.portfolio)).rejects.toThrow(/live/);
  });
});
