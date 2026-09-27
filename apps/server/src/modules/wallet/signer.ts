import { Keypair, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { IntegrityError } from "../../core/errors.js";
import { sha256Hex } from "../../core/hash.js";
import { secrets } from "../../core/secrets.js";
import { decryptSecretKey, readKeystore } from "./keystore.js";

/**
 * The only component that ever touches the private key.
 *
 * It signs a transaction only together with an IntegrityApproval issued by the TransactionGuard
 * for exactly that message (hash-bound, short-lived). This makes it impossible for any code path
 * to sign a transaction that did not pass the integrity checks and the simulation.
 */

export interface IntegrityApproval {
  messageHash: string;
  approvedAt: number;
  checks: string[];
}

const APPROVAL_TTL_MS = 60_000;

export function messageHash(tx: VersionedTransaction): string {
  return sha256Hex(tx.message.serialize());
}

export class Signer {
  #keypair: Keypair | null;
  readonly publicKey: string;

  private constructor(secret: Uint8Array) {
    this.#keypair = Keypair.fromSecretKey(secret);
    this.publicKey = this.#keypair.publicKey.toBase58();
    // make sure the key can never appear in logs in any encoding
    secrets.register(bs58.encode(secret));
    secrets.register(JSON.stringify(Array.from(secret)));
    secrets.register(Buffer.from(secret).toString("base64"));
    secrets.register(Buffer.from(secret).toString("hex"));
    secret.fill(0);
  }

  static fromKeystore(file: string, passphrase: string): Signer {
    return new Signer(decryptSecretKey(readKeystore(file), passphrase));
  }

  /** For tests only. */
  static fromSecretKeyForTests(secret: Uint8Array): Signer {
    return new Signer(Uint8Array.from(secret));
  }

  get ready(): boolean {
    return this.#keypair !== null;
  }

  sign(tx: VersionedTransaction, approval: IntegrityApproval, now = Date.now()): Uint8Array {
    const kp = this.#keypair;
    if (!kp) throw new IntegrityError("SIGNER_DISPOSED", "signer is not available");
    if (approval.messageHash !== messageHash(tx)) {
      throw new IntegrityError("APPROVAL_MISMATCH", "transaction does not match its integrity approval");
    }
    if (now - approval.approvedAt > APPROVAL_TTL_MS) {
      throw new IntegrityError("APPROVAL_EXPIRED", "integrity approval expired");
    }
    const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
    if (feePayer !== this.publicKey) throw new IntegrityError("FEE_PAYER", "fee payer is not the bot wallet");
    tx.sign([kp]);
    return tx.serialize();
  }

  /** Signature of a signed transaction (base58) — known before sending (crash recovery). */
  static signatureOf(tx: VersionedTransaction): string {
    const sig = tx.signatures[0];
    if (!sig) throw new IntegrityError("UNSIGNED", "transaction has no signature");
    return bs58.encode(sig);
  }

  dispose(): void {
    const kp = this.#keypair as unknown as { _keypair?: { secretKey?: Uint8Array } } | null;
    kp?._keypair?.secretKey?.fill(0);
    this.#keypair = null;
  }
}
