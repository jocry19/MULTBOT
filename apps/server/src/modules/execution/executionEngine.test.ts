import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DEFAULT_SETTINGS } from "@multbot/shared";
import { createTestDatabase } from "../../test/db.js";
import { silentLogger } from "../../core/logger.js";
import type { Database } from "../../db/database.js";
import { Signer } from "../wallet/signer.js";
import { ExecutionEngine } from "./executionEngine.js";
import { MAINNET_GENESIS_HASH, associatedTokenAddress } from "./txGuard.js";
import type { SwapProvider, SwapQuote } from "./providers.js";
import type { RpcManager } from "../solana/rpcManager.js";
import { TOKEN_PROGRAM_ID, WSOL_MINT } from "../pumpfun/constants.js";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const kp = Keypair.generate();
const wallet = kp.publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

interface FakeState {
  balance: number;
  genesis: string;
  simErr: unknown;
  simLamports: number;
  simTokens: string;
  statuses: ({ slot: number; confirmations: number; err: unknown; confirmationStatus: "confirmed" } | null)[];
  blockHeight: number;
  sent: string[];
  /** Owner program of the mint account; null = mint does not exist. */
  mintOwner?: string | null;
  /** On-chain error of the landed transaction (only the fee is charged then). */
  txErr?: unknown;
}

function fakeRpc(st: FakeState): RpcManager {
  const rpc = {
    call: async (method: string) => {
      if (method === "getGenesisHash") return st.genesis;
      if (method === "getTokenAccountBalance") throw new Error("could not find account");
      throw new Error(`unexpected ${method}`);
    },
    callVerified: async () => ({ result: { value: st.balance }, verified: true }),
    getAccountInfo: async () =>
      st.mintOwner === null ? null : { lamports: 1, owner: st.mintOwner ?? TOKEN_PROGRAM_ID, data: ["", "base64"], executable: false, rentEpoch: 0 },
    simulateTransaction: async () => ({
      err: st.simErr,
      logs: [],
      accounts: [
        { lamports: st.simLamports, owner: "", data: null },
        { lamports: 0, owner: "", data: { parsed: { info: { tokenAmount: { amount: st.simTokens } } } } },
      ],
    }),
    sendTransaction: async (b64: string) => {
      st.sent.push(b64);
      return "sig";
    },
    getSignatureStatuses: async () => [st.statuses.shift() ?? null],
    getBlockHeight: async () => st.blockHeight,
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 3)), lastValidBlockHeight: 1000 }),
    getTransaction: async () => ({
      slot: 42,
      blockTime: 1_800_000_000,
      meta: st.txErr
        ? { err: st.txErr, fee: 105_000, preBalances: [st.balance], postBalances: [st.balance - 105_000], logMessages: [], preTokenBalances: [], postTokenBalances: [] }
        : {
            err: null,
            fee: 5000,
            preBalances: [st.balance],
            postBalances: [st.balance - 10_300_000],
            logMessages: [],
            preTokenBalances: [],
            postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: "350000000000", decimals: 6, uiAmount: 350000 } }],
          },
      transaction: { signatures: ["x"], message: { accountKeys: [wallet], recentBlockhash: "", instructions: [] } },
    }),
  };
  return rpc as unknown as RpcManager;
}

/** Provider that returns a Jupiter-like wrap/swap/unwrap transaction (swap simulated by syncNative). */
function fakeProvider(opts: { drain?: boolean; priceImpactPct?: number } = {}): SwapProvider {
  return {
    name: "jupiter",
    quote: async (p): Promise<SwapQuote> => ({ provider: "jupiter", inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 350_000_000_000n, minOut: 330_000_000_000n, priceImpactPct: opts.priceImpactPct ?? 1, route: ["Pump.fun"], raw: {} }),
    build: async () => {
      const wsolAta = new PublicKey(associatedTokenAddress(wallet, WSOL_MINT));
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: opts.drain ? Keypair.generate().publicKey : wsolAta, lamports: 10_000_000 }),
        new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM_ID), keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
      ];
      const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message();
      return { txBase64: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight: 1000, prioritizationFeeLamports: 100_000 };
    },
  };
}

function engine(st: FakeState, provider = fakeProvider()): ExecutionEngine {
  return new ExecutionEngine(db, fakeRpc(st), Signer.fromSecretKeyForTests(kp.secretKey), { jupiter: provider }, () => DEFAULT_SETTINGS, { now: () => Date.now() }, silentLogger(), {
    pollMs: 5,
    confirmTimeoutMs: 2_000,
  });
}

const baseState = (): FakeState => ({
  balance: 1_000_000_000,
  genesis: MAINNET_GENESIS_HASH,
  simErr: null,
  simLamports: 1_000_000_000 - 10_300_000,
  simTokens: "350000000000",
  statuses: [null, { slot: 42, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
  blockHeight: 900,
  sent: [],
});

describe("ExecutionEngine", () => {
  it("executes a buy end to end and records the actual on-chain result", async () => {
    const st = baseState();
    const r = await engine(st).execute({ idempotencyKey: "buy-1", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("CONFIRMED");
    expect(r.signature).toBeTruthy();
    expect(r.solDeltaLamports).toBe(-10_300_000);
    expect(r.tokenDeltaRaw).toBe(350_000_000_000n);
    expect(st.sent.length).toBeGreaterThanOrEqual(1);
    const order = await db.one<{ status: string; signature: string; validation: unknown; simulation: unknown }>("SELECT status, signature, validation, simulation FROM orders WHERE idempotency_key = 'buy-1'");
    expect(order?.status).toBe("CONFIRMED");
    expect(order?.validation).toBeTruthy();
    expect(order?.simulation).toBeTruthy();
  });

  it("is idempotent: the same key never sends a second transaction", async () => {
    const st = baseState();
    const r = await engine(st).execute({ idempotencyKey: "buy-1", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("CONFIRMED");
    expect(st.sent).toHaveLength(0);
  });

  it("refuses to sign when the simulation fails or moves unexpected amounts", async () => {
    const st = { ...baseState(), simErr: { InstructionError: [3, { Custom: 6001 }] } };
    const r = await engine(st).execute({ idempotencyKey: "buy-simfail", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("REJECTED");
    expect(r.error).toMatch(/simulation failed/);
    expect(st.sent).toHaveLength(0);
    const st2 = { ...baseState(), simTokens: "1" }; // far below minimum output
    const r2 = await engine(st2).execute({ idempotencyKey: "buy-short", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r2.status).toBe("REJECTED");
    expect(st2.sent).toHaveLength(0);
  });

  it("rejects transactions that would send SOL elsewhere", async () => {
    const st = baseState();
    const r = await engine(st, fakeProvider({ drain: true })).execute({ idempotencyKey: "buy-drain", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("REJECTED");
    expect(r.error).toMatch(/unknown address/);
    expect(st.sent).toHaveLength(0);
  });

  it("refuses when SOL is insufficient (reserve respected) or the RPC is not mainnet", async () => {
    const st = { ...baseState(), balance: 20_000_000 };
    const r = await engine(st).execute({ idempotencyKey: "buy-poor", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("REJECTED");
    expect(r.error).toMatch(/insufficient SOL/);
    const st2 = { ...baseState(), genesis: "devnetGenesis111" };
    const r2 = await engine(st2).execute({ idempotencyKey: "buy-devnet", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r2.status).toBe("REJECTED");
    expect(r2.error).toMatch(/not Solana mainnet/);
  });

  it("marks orders EXPIRED when the blockhash dies without confirmation", async () => {
    const st = { ...baseState(), statuses: [], blockHeight: 2000 };
    const r = await engine(st).execute({ idempotencyKey: "buy-expire", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("EXPIRED");
  });

  // --- failure simulations -------------------------------------------------------------------

  it("refuses a trade whose price impact exceeds the slippage limit (thin liquidity)", async () => {
    const st = baseState();
    const r = await engine(st, fakeProvider({ priceImpactPct: 22 })).execute({ idempotencyKey: "buy-impact", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("REJECTED");
    expect(r.error).toMatch(/price impact/);
    expect(st.sent).toHaveLength(0);
  });

  it("refuses invalid or non-existent token mints before building anything", async () => {
    const st = { ...baseState(), mintOwner: "11111111111111111111111111111111" };
    const r = await engine(st).execute({ idempotencyKey: "buy-notmint", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("REJECTED");
    expect(r.error).toMatch(/not a token mint/);
    const st2 = { ...baseState(), mintOwner: null };
    const r2 = await engine(st2).execute({ idempotencyKey: "buy-nomint", liveTradeId: null, kind: "buy", mint: Keypair.generate().publicKey.toBase58(), amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r2.status).toBe("REJECTED");
    expect(r2.error).toMatch(/does not exist/);
    expect([...st.sent, ...st2.sent]).toHaveLength(0);
  });

  it("after a crash, resumes a sent order by confirming it instead of sending again", async () => {
    await db.query(
      `INSERT INTO orders (id, idempotency_key, kind, mint, status, provider, input_amount, signature, last_valid_block_height, sent_at)
       VALUES ('crash-sent', 'buy-crash-sent', 'buy', $1, 'SENT', 'jupiter', 10000000, 'sigCrashSent', 1000, now())`,
      [MINT],
    );
    const st = { ...baseState(), statuses: [{ slot: 42, confirmations: 1, err: null, confirmationStatus: "confirmed" as const }] };
    const r = await engine(st).resume("buy-crash-sent");
    expect(r.status).toBe("CONFIRMED");
    expect(r.tokenDeltaRaw).toBe(350_000_000_000n);
    expect(st.sent).toHaveLength(0);
    // a duplicate request with the same key returns the stored result
    const again = await engine(baseState()).execute({ idempotencyKey: "buy-crash-sent", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(again.status).toBe("CONFIRMED");
  });

  it("after a crash before signing, marks the order failed (nothing was sent, a new decision is needed)", async () => {
    await db.query(
      `INSERT INTO orders (id, idempotency_key, kind, mint, status, provider, input_amount) VALUES ('crash-quoted', 'buy-crash-quoted', 'buy', $1, 'QUOTED', 'jupiter', 10000000)`,
      [MINT],
    );
    const st = baseState();
    const r = await engine(st).resume("buy-crash-quoted");
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/before signing/);
    expect(st.sent).toHaveLength(0);
  });

  it("records a failed on-chain transaction as failed (fees paid, no position)", async () => {
    const txErr = { InstructionError: [2, { Custom: 6001 }] };
    const st = { ...baseState(), txErr, statuses: [{ slot: 42, confirmations: 1, err: txErr, confirmationStatus: "confirmed" as const }] };
    const r = await engine(st).execute({ idempotencyKey: "buy-onchain-fail", liveTradeId: null, kind: "buy", mint: MINT, amount: 10_000_000n, maxSlippageBps: 1500 });
    expect(r.status).toBe("FAILED");
    expect(r.tokenDeltaRaw ?? 0n).toBe(0n);
    expect(r.solDeltaLamports).toBe(-105_000);
  });
});
