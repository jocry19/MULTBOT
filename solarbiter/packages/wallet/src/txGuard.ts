import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SOL_MINT } from "@solarbiter/shared";
import { IntegrityError } from "@solarbiter/shared/node";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type SimulationResult,
} from "@solarbiter/solana";
import { messageHash, type IntegrityApproval } from "./signer.js";

/**
 * Transaction integrity checks. Technical safety mechanisms, not trading opinions — no setting can
 * disable them, and the signer refuses anything that has not passed them.
 *
 * Static checks (decoded message):
 *   - fee payer is the bot wallet and it is the only required signer
 *   - every top-level program is allow-listed (program ids from lookup tables are refused)
 *   - System: only transfers — to the wallet's own wSOL account (bounded by the trade size) or to a
 *     Jito tip account (bounded by the tip limit)
 *   - Token program top level: only SyncNative and CloseAccount back to the bot wallet
 *   - ATA creation only for the bot wallet as payer and owner
 *   - compute unit price × limit within the priority-fee limit
 * Simulation checks: no error, and the wallet never loses more SOL than fees + tip + locked rent.
 */

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const ALLOWED_PROGRAMS = new Set([COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_V6_PROGRAM_ID]);

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0].toBase58();
}

export interface GuardPolicy {
  wallet: string;
  maxPriorityFeeLamports: number;
  /** Max lamports wrapped into the own wSOL account (≈ trade size). */
  maxWrapLamports: number;
  /** Jito tip accounts and the maximum tip. */
  tipAccounts: string[];
  maxTipLamports: number;
}

export interface StaticReport {
  messageHash: string;
  programs: string[];
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: number | null;
  priorityFeeLamports: number;
  wrapLamports: number;
  tipLamports: number;
  checks: string[];
}

const u32 = (d: Uint8Array, o: number): number => Buffer.from(d).readUInt32LE(o);
const u64 = (d: Uint8Array, o: number): number => Number(Buffer.from(d).readBigUInt64LE(o));

export function inspectTransaction(tx: VersionedTransaction, policy: GuardPolicy): StaticReport {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const checks: string[] = [];
  if (keys[0] !== policy.wallet) throw new IntegrityError("FEE_PAYER", "fee payer is not the bot wallet");
  if (msg.header.numRequiredSignatures !== 1) throw new IntegrityError("SIGNERS", "transaction requires signers other than the bot wallet");
  checks.push("fee payer = bot wallet, single signer");

  const wsolAta = associatedTokenAddress(policy.wallet, SOL_MINT);
  const tips = new Set(policy.tipAccounts);
  let cuLimit: number | null = null;
  let cuPrice: number | null = null;
  let wrapLamports = 0;
  let tipLamports = 0;
  const programs = new Set<string>();
  const acct = (ix: { accountKeyIndexes: number[] }, i: number): string | undefined => {
    const idx = ix.accountKeyIndexes[i];
    return idx === undefined ? undefined : keys[idx];
  };

  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) throw new IntegrityError("PROGRAM", "program id loaded from lookup table (not allowed)");
    if (!ALLOWED_PROGRAMS.has(program)) throw new IntegrityError("PROGRAM", `program ${program} is not allow-listed`);
    programs.add(program);
    const data = ix.data;
    switch (program) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const tag = data[0];
        if (tag === 2) cuLimit = u32(data, 1);
        else if (tag === 3) cuPrice = u64(data, 1);
        else throw new IntegrityError("COMPUTE_BUDGET", `unexpected compute budget instruction ${tag}`);
        break;
      }
      case SYSTEM_PROGRAM_ID: {
        const kind = data.length >= 12 ? u32(data, 0) : -1;
        if (kind !== 2) throw new IntegrityError("SYSTEM", `System instruction ${kind} not allowed`);
        const from = acct(ix, 0);
        const to = acct(ix, 1);
        const lamports = u64(data, 4);
        if (from !== policy.wallet) throw new IntegrityError("SYSTEM", "transfer source is not the bot wallet");
        if (to === wsolAta) {
          wrapLamports += lamports;
          if (wrapLamports > policy.maxWrapLamports) throw new IntegrityError("TRANSFER_AMOUNT", `wrapping ${wrapLamports} lamports exceeds the trade size`);
        } else if (to && tips.has(to)) {
          tipLamports += lamports;
          if (tipLamports > policy.maxTipLamports) throw new IntegrityError("TIP_AMOUNT", `tip ${tipLamports} lamports exceeds the limit`);
        } else {
          throw new IntegrityError("TRANSFER_DESTINATION", `SOL transfer to unknown address ${to}`);
        }
        break;
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        const tag = data[0];
        if (tag === 17) break; // SyncNative
        if (tag === 9) {
          if (acct(ix, 1) !== policy.wallet || acct(ix, 2) !== policy.wallet) throw new IntegrityError("CLOSE_ACCOUNT", "close account must refund to the bot wallet");
          break;
        }
        throw new IntegrityError("TOKEN_INSTRUCTION", `token instruction ${tag} not allowed at top level`);
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        if (acct(ix, 0) !== policy.wallet || acct(ix, 2) !== policy.wallet) throw new IntegrityError("ATA", "token account must be created for and paid by the bot wallet");
        break;
      }
      default:
        break; // Jupiter: amounts and minimum outputs are verified when the instructions are built, effects in simulation
    }
  }
  checks.push("programs allow-listed", "SOL transfers only to own wSOL account / Jito tip accounts");
  const priorityFeeLamports = cuPrice !== null ? Math.ceil(((cuLimit ?? 200_000) * cuPrice) / 1_000_000) : 0;
  if (priorityFeeLamports > policy.maxPriorityFeeLamports) throw new IntegrityError("PRIORITY_FEE", `priority fee ${priorityFeeLamports} lamports exceeds limit ${policy.maxPriorityFeeLamports}`);
  checks.push("priority fee within limit");
  return { messageHash: messageHash(tx), programs: [...programs], computeUnitLimit: cuLimit, computeUnitPriceMicroLamports: cuPrice, priorityFeeLamports, wrapLamports, tipLamports, checks };
}

export interface SimulationReport {
  solDelta: number;
  unitsConsumed: number | null;
  checks: string[];
}

/**
 * accounts[0] must be the wallet. The wallet may not lose more than `maxLossLamports`
 * (fees + tip + rent of newly created token accounts) — the closing leg's minimum output makes the
 * swap itself non-negative.
 */
export function checkSimulation(sim: SimulationResult, preLamports: number, maxLossLamports: number): SimulationReport {
  if (sim.err) throw new IntegrityError("SIMULATION_FAILED", `simulation failed: ${JSON.stringify(sim.err)}`);
  const w = sim.accounts?.[0];
  if (!w) throw new IntegrityError("SIMULATION_ACCOUNTS", "simulation did not return the wallet account");
  const solDelta = w.lamports - preLamports;
  if (-solDelta > maxLossLamports) throw new IntegrityError("SOL_OUT", `simulation loses ${-solDelta} lamports, more than fees + tip + rent (${maxLossLamports})`);
  return { solDelta, unitsConsumed: sim.unitsConsumed ?? null, checks: ["simulation succeeded", "wallet balance change within bounds"] };
}

export function approve(report: StaticReport, sim: SimulationReport, now = Date.now()): IntegrityApproval {
  return { messageHash: report.messageHash, approvedAt: now, checks: [...report.checks, ...sim.checks] };
}

export function decodeTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch (err) {
    throw new IntegrityError("DECODE", `transaction could not be decoded: ${(err as Error).message}`);
  }
}
