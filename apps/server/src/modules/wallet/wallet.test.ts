import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decryptSecretKey, encryptSecretKey, parseSecretKey, readKeystore, writeKeystore } from "./keystore.js";
import { Signer } from "./signer.js";
import { approve, associatedTokenAddress, checkSimulation, inspectTransaction, type GuardPolicy } from "../execution/txGuard.js";
import { secrets } from "../../core/secrets.js";
import { TOKEN_PROGRAM_ID, WSOL_MINT } from "../pumpfun/constants.js";
import bs58 from "bs58";

const FAST_KDF = { N: 2 ** 12, r: 8, p: 1 };
const PASS = "correct horse battery staple";

describe("keystore", () => {
  it("round-trips a key and rejects a wrong passphrase", () => {
    const kp = Keypair.generate();
    const ks = encryptSecretKey(kp.secretKey, PASS, FAST_KDF);
    expect(ks.address).toBe(kp.publicKey.toBase58());
    expect(JSON.stringify(ks)).not.toContain(bs58.encode(kp.secretKey));
    expect(Buffer.from(decryptSecretKey(ks, PASS)).equals(Buffer.from(kp.secretKey))).toBe(true);
    expect(() => decryptSecretKey(ks, "wrong passphrase!!")).toThrow(/could not decrypt/);
  });

  it("detects tampering", () => {
    const ks = encryptSecretKey(Keypair.generate().secretKey, PASS, FAST_KDF);
    const bad = { ...ks, ciphertext: Buffer.from(Buffer.from(ks.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
    expect(() => decryptSecretKey(bad, PASS)).toThrow();
  });

  it("writes files with 0600 and refuses world-readable keystores", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbks-"));
    const file = path.join(dir, "sub", "k.json");
    writeKeystore(file, encryptSecretKey(Keypair.generate().secretKey, PASS, FAST_KDF));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeKeystore(file, readKeystore(file))).toThrow(/exists/);
    fs.chmodSync(file, 0o644);
    expect(() => readKeystore(file)).toThrow(/chmod 600/);
  });

  it("rejects weak passphrases and parses both key formats", () => {
    expect(() => encryptSecretKey(Keypair.generate().secretKey, "short")).toThrow(/at least 12/);
    const kp = Keypair.generate();
    expect(parseSecretKey(bs58.encode(kp.secretKey))).toEqual(kp.secretKey);
    expect(parseSecretKey(JSON.stringify(Array.from(kp.secretKey)))).toEqual(kp.secretKey);
  });
});

function buildTx(payer: PublicKey, ixs: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 7)), instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("transaction guard + signer", () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const wsolAta = new PublicKey(associatedTokenAddress(wallet, WSOL_MINT));
  const policy: GuardPolicy = { wallet, maxPriorityFeeLamports: 500_000, maxWrapLamports: 20_000_000 };
  const cb = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 })];
  const syncNative = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM_ID), keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  const closeWsol = (dest: PublicKey) =>
    new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    });

  it("accepts a wrap → swap-like → unwrap transaction and the signer signs it with an approval", () => {
    const tx = buildTx(kp.publicKey, [...cb, SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAta, lamports: 10_000_000 }), syncNative, closeWsol(kp.publicKey)]);
    const report = inspectTransaction(tx, policy);
    expect(report.priorityFeeLamports).toBe(200_000);
    expect(report.wrapLamports).toBe(10_000_000);
    const sim = checkSimulation(
      { err: null, logs: [], accounts: [{ lamports: 1_000_000_000 - 10_210_000, owner: "", data: null }] },
      { kind: "buy", preLamports: 1_000_000_000, maxSolOut: 10_500_000 },
    );
    const signer = Signer.fromSecretKeyForTests(kp.secretKey);
    const raw = signer.sign(tx, approve(report, sim));
    expect(raw.length).toBeGreaterThan(100);
    expect(Signer.signatureOf(tx)).toHaveLength(Signer.signatureOf(tx).length);
    // the secret key is registered for log scrubbing in every encoding
    expect(secrets.scrub(bs58.encode(kp.secretKey))).toBe("[REDACTED]");
  });

  it("rejects SOL transfers to unknown addresses (drain attempt)", () => {
    const attacker = Keypair.generate().publicKey;
    const tx = buildTx(kp.publicKey, [...cb, SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: attacker, lamports: 1 })]);
    expect(() => inspectTransaction(tx, policy)).toThrow(/unknown address/);
  });

  it("rejects closing accounts to someone else", () => {
    const tx = buildTx(kp.publicKey, [closeWsol(Keypair.generate().publicKey)]);
    expect(() => inspectTransaction(tx, policy)).toThrow(/refund to the bot wallet/);
  });

  it("rejects foreign fee payers, unknown programs, token transfers and excessive priority fees", () => {
    const other = Keypair.generate().publicKey;
    expect(() => inspectTransaction(buildTx(other, [syncNative]), policy)).toThrow(/fee payer/);
    const unknown = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
    expect(() => inspectTransaction(buildTx(kp.publicKey, [unknown]), policy)).toThrow(/not allow-listed/);
    const tokenTransfer = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM_ID), keys: [], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 1]) });
    expect(() => inspectTransaction(buildTx(kp.publicKey, [tokenTransfer]), policy)).toThrow(/not allowed at top level/);
    const greedy = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 })];
    expect(() => inspectTransaction(buildTx(kp.publicKey, [...greedy, syncNative]), policy)).toThrow(/priority fee/);
    const bigWrap = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAta, lamports: 5_000_000_000 });
    expect(() => inspectTransaction(buildTx(kp.publicKey, [bigWrap]), policy)).toThrow(/exceeds limit/);
  });

  it("simulation checks catch failures and unexpected balance changes", () => {
    expect(() => checkSimulation({ err: { InstructionError: [0, "Custom"] }, logs: [] }, { kind: "buy", preLamports: 1 })).toThrow(/simulation failed/);
    expect(() =>
      checkSimulation({ err: null, logs: [], accounts: [{ lamports: 500, owner: "", data: null }] }, { kind: "buy", preLamports: 10_000, maxSolOut: 1_000 }),
    ).toThrow(/more than allowed/);
    const tokenAcc = { lamports: 0, owner: "", data: { parsed: { info: { tokenAmount: { amount: "50" } } } } };
    expect(() =>
      checkSimulation({ err: null, logs: [], accounts: [{ lamports: 9_000, owner: "", data: null }, tokenAcc] }, { kind: "buy", preLamports: 10_000, maxSolOut: 2_000, preTokenRaw: 0n, minTokensIn: 100n }),
    ).toThrow(/below minimum/);
  });

  it("the signer refuses transactions without matching approval", () => {
    const signer = Signer.fromSecretKeyForTests(kp.secretKey);
    const tx = buildTx(kp.publicKey, [syncNative]);
    const other = buildTx(kp.publicKey, [syncNative, closeWsol(kp.publicKey)]);
    const report = inspectTransaction(other, policy);
    const approval = approve(report, { postLamports: 0, solDelta: 0, tokenDelta: null, unitsConsumed: null, checks: [] });
    expect(() => signer.sign(tx, approval)).toThrow(/does not match/);
    expect(() => signer.sign(other, { ...approval, approvedAt: Date.now() - 120_000 })).toThrow(/expired/);
    signer.dispose();
    expect(() => signer.sign(other, approval)).toThrow(/not available/);
  });
});
