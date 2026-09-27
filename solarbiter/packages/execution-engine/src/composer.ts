import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { SwapInstructions, WireInstruction } from "@solarbiter/dex";
import type { RpcManager } from "@solarbiter/solana";

/** Maximum serialized transaction size on Solana. */
export const MAX_TX_BYTES = 1232;

export class NotAtomicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAtomicError";
  }
}

export function toInstruction(w: WireInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(w.programId),
    keys: w.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(w.data, "base64"),
  });
}

/**
 * Instruction order of one atomic arbitrage transaction:
 *
 *   compute budget (limit, price)
 *   leg 1 setup, leg 1 swap
 *   …intermediate legs…
 *   set_token_ledger (closing leg)  ← right before the swap that delivers the closing leg's input,
 *                                     after that leg's setup created the token account
 *   closing leg setup, closing leg swap (sells exactly the delivered amount, minimum = profit guard)
 *   closing leg cleanup (unwrap wSOL)
 *   Jito tip transfer
 *
 * Jupiter's own compute-budget instructions are replaced; intermediate cleanups are dropped (the
 * closing cleanup unwraps everything).
 */
export function composeInstructions(legs: SwapInstructions[], o: { computeUnitLimit: number; computeUnitPriceMicroLamports: number; tip: TransactionInstruction | null }): TransactionInstruction[] {
  if (legs.length < 2) throw new Error("an arbitrage needs at least two legs");
  const last = legs[legs.length - 1] as SwapInstructions;
  if (!last.tokenLedger) throw new Error("closing leg must use the token ledger");
  for (const l of legs) if (l.other.length) throw new Error("unexpected extra instructions in a swap build");
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.computeUnitPriceMicroLamports }),
  ];
  const penultimate = legs.length - 2;
  legs.forEach((leg, i) => {
    if (i === legs.length - 1) return;
    ixs.push(...leg.setup.map(toInstruction));
    if (i === penultimate) ixs.push(toInstruction(last.tokenLedger as WireInstruction));
    ixs.push(toInstruction(leg.swap));
  });
  ixs.push(...last.setup.map(toInstruction), toInstruction(last.swap));
  if (last.cleanup) ixs.push(toInstruction(last.cleanup));
  if (o.tip) ixs.push(o.tip);
  return ixs;
}

/** Address lookup tables with a short cache (they change rarely). */
export class LookupTableCache {
  private readonly cache = new Map<string, { at: number; table: AddressLookupTableAccount }>();

  constructor(
    private readonly rpc: RpcManager,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(addresses: string[]): Promise<AddressLookupTableAccount[]> {
    const unique = [...new Set(addresses)];
    const t = this.now();
    const missing = unique.filter((a) => {
      const c = this.cache.get(a);
      return !c || t - c.at > this.ttlMs;
    });
    if (missing.length) {
      const accounts = await this.rpc.getMultipleAccounts(missing);
      missing.forEach((a, i) => {
        const acc = accounts[i];
        if (!acc) throw new Error(`lookup table ${a} not found`);
        const state = AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], "base64"));
        this.cache.set(a, { at: t, table: new AddressLookupTableAccount({ key: new PublicKey(a), state }) });
      });
    }
    return unique.map((a) => (this.cache.get(a) as { table: AddressLookupTableAccount }).table);
  }
}

/** Compile a v0 transaction; refuse it if it does not fit (then the route is not atomic). */
export function buildTransaction(payer: string, recentBlockhash: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash, instructions: ixs }).compileToV0Message(tables);
    tx = new VersionedTransaction(msg);
  } catch (err) {
    throw new NotAtomicError(`transaction cannot be compiled: ${(err as Error).message}`);
  }
  let size: number;
  try {
    size = tx.serialize().length;
  } catch (err) {
    throw new NotAtomicError(`transaction too large: ${(err as Error).message}`);
  }
  if (size > MAX_TX_BYTES) throw new NotAtomicError(`transaction is ${size} bytes (max ${MAX_TX_BYTES})`);
  return tx;
}

/** Compute-unit limit from a simulation: consumed + 10 % + fixed margin, bounded. */
export function optimizedComputeUnits(consumed: number | null, fallback: number): number {
  if (!consumed || consumed <= 0) return fallback;
  return Math.min(1_400_000, Math.ceil((consumed * 11) / 10) + 10_000);
}

/** Price per CU so that limit × price equals the chosen priority fee. */
export function microLamportsPerCu(priorityFeeLamports: bigint, computeUnitLimit: number): number {
  if (computeUnitLimit <= 0) return 0;
  return Math.floor((Number(priorityFeeLamports) * 1_000_000) / computeUnitLimit);
}
