import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Encrypted keystore for the bot wallet.
 *
 * The private key exists in plaintext only in process memory of the signer. On disk it is
 * AES-256-GCM encrypted with a key derived from a passphrase via scrypt (N = 2^17). The passphrase
 * comes from the environment (WALLET_KEYSTORE_PASSPHRASE / _FILE) — never from the database, the
 * frontend or the API. The keystore file is written with mode 0600 in a 0700 directory and is
 * git-ignored.
 */

export interface KeystoreFile {
  version: 1;
  address: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
  createdAt: string;
}

const KDF = { N: 2 ** 17, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 512 * 1024 * 1024 });
}

export function assertStrongPassphrase(passphrase: string): void {
  if (passphrase.length < 12) throw new Error("keystore passphrase must be at least 12 characters");
}

export function encryptSecretKey(secretKey: Uint8Array, passphrase: string, kdf = KDF): KeystoreFile {
  assertStrongPassphrase(passphrase);
  if (secretKey.length !== 64) throw new Error("secret key must be 64 bytes");
  const kp = Keypair.fromSecretKey(secretKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  key.fill(0);
  return {
    version: 1,
    address: kp.publicKey.toBase58(),
    kdf: "scrypt",
    kdfParams: { ...kdf, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

/** Decrypts and verifies that the key matches the stored address. Throws on a wrong passphrase. */
export function decryptSecretKey(ks: KeystoreFile, passphrase: string): Uint8Array {
  if (ks.version !== 1 || ks.cipher !== "aes-256-gcm" || ks.kdf !== "scrypt") throw new Error("unsupported keystore format");
  const key = deriveKey(passphrase, Buffer.from(ks.kdfParams.salt, "base64"), ks.kdfParams);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ks.iv, "base64"));
    decipher.setAuthTag(Buffer.from(ks.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ks.ciphertext, "base64")), decipher.final()]);
    const secret = new Uint8Array(plain);
    plain.fill(0);
    const kp = Keypair.fromSecretKey(secret);
    if (kp.publicKey.toBase58() !== ks.address) throw new Error("keystore address mismatch");
    return secret;
  } catch (err) {
    if ((err as Error).message.includes("address mismatch")) throw err;
    throw new Error("could not decrypt keystore (wrong passphrase or corrupted file)");
  } finally {
    key.fill(0);
  }
}

export function writeKeystore(file: string, ks: KeystoreFile, overwrite = false): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!overwrite && fs.existsSync(file)) throw new Error(`keystore ${file} already exists`);
  fs.writeFileSync(file, `${JSON.stringify(ks, null, 2)}\n`, { mode: 0o600 });
}

export function readKeystore(file: string): KeystoreFile {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0 && process.platform !== "win32") {
    throw new Error(`keystore ${file} is readable by group/others (chmod 600 required)`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as KeystoreFile;
}

/** Parses a secret key given as base58 string or JSON byte array (solana-keygen format). */
export function parseSecretKey(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith("[")) {
    const arr = JSON.parse(s) as number[];
    return Uint8Array.from(arr);
  }
  return bs58.decode(s);
}
