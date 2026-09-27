import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { IntegrityError } from "../../core/errors.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../pumpfun/constants.js";
import type { SimulationResult } from "../solana/rpcManager.js";
import { messageHash, type IntegrityApproval } from "../wallet/signer.js";

/**
 * Transaction integrity checks. These are technical safety mechanisms, not trading opinions —
 * they cannot be disabled by any setting.
 *
 * Static checks (on the decoded message):
 *   - fee payer is the bot wallet and it is the only required signer
 *   - every top-level program is allow-listed
 *   - System transfers only to the wallet's own WSOL account or explicitly allowed fee/tip accounts
 *     (bounded amounts); no other System instructions
 *   - Token program: only syncNative and closeAccount back to the bot wallet
 *   - ATA creation only for the bot wallet as owner/payer
 *   - total priority fee within the configured limit
 * Simulation checks (after simulateTransaction):
 *   - no error
 *   - SOL spent / received and token balance change within the expected bounds
 */

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const DEFAULT_ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
]);

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0].toBase58();
}

export interface GuardPolicy {
  wallet: string;
  maxPriorityFeeLamports: number;
  allowedPrograms?: Set<string>;
  /** Extra transfer destinations (tips / provider fees) with a max amount each. */
  allowedTransferDestinations?: Map<string, number>;
  /** Max lamports a single System transfer to the own WSOL account may move (≈ trade size + margin). */
  maxWrapLamports: number;
}

export interface StaticReport {
  messageHash: string;
  programs: string[];
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: number | null;
  priorityFeeLamports: number;
  wrapLamports: number;
  extraTransfers: { to: string; lamports: number }[];
  checks: string[];
}

function u32(data: Uint8Array, off: number): number {
  return Buffer.from(data).readUInt32LE(off);
}
function u64(data: Uint8Array, off: number): number {
  return Number(Buffer.from(data).readBigUInt64LE(off));
}

/** Static validation of the transaction message. Throws IntegrityError on any violation. */
export function inspectTransaction(tx: VersionedTransaction, policy: GuardPolicy): StaticReport {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const checks: string[] = [];
  if (keys[0] !== policy.wallet) throw new IntegrityError("FEE_PAYER", "fee payer is not the bot wallet");
  if (msg.header.numRequiredSignatures !== 1) throw new IntegrityError("SIGNERS", "transaction requires signers other than the bot wallet");
  checks.push("fee payer = bot wallet, single signer");

  const allowed = policy.allowedPrograms ?? DEFAULT_ALLOWED_PROGRAMS;
  const wsolAta = associatedTokenAddress(policy.wallet, WSOL_MINT);
  let cuLimit: number | null = null;
  let cuPrice: number | null = null;
  let wrapLamports = 0;
  const extraTransfers: { to: string; lamports: number }[] = [];
  const programs = new Set<string>();
  const acct = (ix: { accountKeyIndexes: number[] }, i: number): string | undefined => {
    const idx = ix.accountKeyIndexes[i];
    return idx === undefined ? undefined : keys[idx];
  };

  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) throw new IntegrityError("PROGRAM", "program id loaded from lookup table (not allowed)");
    if (!allowed.has(program)) throw new IntegrityError("PROGRAM", `program ${program} is not allow-listed`);
    programs.add(program);
    const data = ix.data;
    switch (program) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const tag = data[0];
        if (tag === 2) cuLimit = u32(data, 1);
        else if (tag === 3) cuPrice = u64(data, 1);
        else if (tag !== 4) throw new IntegrityError("COMPUTE_BUDGET", `unexpected compute budget instruction ${tag}`);
        break;
      }
      case SYSTEM_PROGRAM_ID: {
        const kind = data.length >= 4 ? u32(data, 0) : -1;
        if (kind !== 2) throw new IntegrityError("SYSTEM", `System instruction ${kind} not allowed`);
        const from = acct(ix, 0);
        const to = acct(ix, 1);
        const lamports = u64(data, 4);
        if (from !== policy.wallet) throw new IntegrityError("SYSTEM", "transfer source is not the bot wallet");
        if (to === wsolAta) {
          if (lamports > policy.maxWrapLamports) throw new IntegrityError("TRANSFER_AMOUNT", `wrap of ${lamports} lamports exceeds limit`);
          wrapLamports += lamports;
        } else {
          const cap = to ? policy.allowedTransferDestinations?.get(to) : undefined;
          if (cap === undefined) throw new IntegrityError("TRANSFER_DESTINATION", `SOL transfer to unknown address ${to}`);
          if (lamports > cap) throw new IntegrityError("TRANSFER_AMOUNT", `transfer to ${to} exceeds cap`);
          extraTransfers.push({ to: to as string, lamports });
        }
        break;
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        const tag = data[0];
        if (tag === 17) break; // SyncNative
        if (tag === 9) {
          // CloseAccount: [account, destination, owner]
          if (acct(ix, 1) !== policy.wallet || acct(ix, 2) !== policy.wallet) {
            throw new IntegrityError("CLOSE_ACCOUNT", "close account must refund to the bot wallet");
          }
          break;
        }
        throw new IntegrityError("TOKEN_INSTRUCTION", `token instruction ${tag} not allowed at top level`);
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        // Create / CreateIdempotent: [payer, ata, owner, mint, system, tokenProgram]
        if (acct(ix, 0) !== policy.wallet || acct(ix, 2) !== policy.wallet) {
          throw new IntegrityError("ATA", "token account must be created for and paid by the bot wallet");
        }
        break;
      }
      default:
        break; // allow-listed swap programs are validated through simulation
    }
  }
  checks.push("programs allow-listed", "transfers restricted to own accounts");
  const priorityFeeLamports = cuPrice !== null ? Math.ceil(((cuLimit ?? 200_000) * cuPrice) / 1_000_000) : 0;
  if (priorityFeeLamports > policy.maxPriorityFeeLamports) {
    throw new IntegrityError("PRIORITY_FEE", `priority fee ${priorityFeeLamports} lamports exceeds limit ${policy.maxPriorityFeeLamports}`);
  }
  checks.push("priority fee within limit");
  return {
    messageHash: messageHash(tx),
    programs: [...programs],
    computeUnitLimit: cuLimit,
    computeUnitPriceMicroLamports: cuPrice,
    priorityFeeLamports,
    wrapLamports,
    extraTransfers,
    checks,
  };
}

export interface ExpectedEffect {
  kind: "buy" | "sell" | "transfer";
  /** Wallet lamports before the transaction. */
  preLamports: number;
  /** Maximum lamports that may leave the wallet (buy: amount + fees + rent; transfer: amount + fee). */
  maxSolOut?: number;
  /** Minimum lamports the wallet must gain (sell). */
  minSolIn?: number;
  /** Token account balance before (raw). */
  preTokenRaw?: bigint;
  /** Buy: minimum raw tokens that must arrive. */
  minTokensIn?: bigint;
  /** Sell: maximum raw tokens that may leave. */
  maxTokensOut?: bigint;
}

export interface SimulationReport {
  postLamports: number;
  solDelta: number;
  tokenDelta: bigint | null;
  unitsConsumed: number | null;
  checks: string[];
}

/** Checks simulated post-state against the expected effect. accounts[0] = wallet, accounts[1] = token account. */
export function checkSimulation(sim: SimulationResult, expected: ExpectedEffect): SimulationReport {
  if (sim.err) throw new IntegrityError("SIMULATION_FAILED", `simulation failed: ${JSON.stringify(sim.err)}`);
  const walletAcc = sim.accounts?.[0];
  if (!walletAcc) throw new IntegrityError("SIMULATION_ACCOUNTS", "simulation did not return the wallet account");
  const postLamports = walletAcc.lamports;
  const solDelta = postLamports - expected.preLamports;
  const checks = ["simulation succeeded"];
  let tokenDelta: bigint | null = null;
  const tokenAcc = sim.accounts?.[1];
  if (tokenAcc) {
    const parsed = (tokenAcc.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
    const post = BigInt(parsed?.info?.tokenAmount?.amount ?? "0");
    tokenDelta = post - (expected.preTokenRaw ?? 0n);
  } else if (expected.minTokensIn !== undefined || expected.maxTokensOut !== undefined) {
    tokenDelta = -(expected.preTokenRaw ?? 0n); // account closed / not present
  }
  if (expected.maxSolOut !== undefined && -solDelta > expected.maxSolOut) {
    throw new IntegrityError("SOL_OUT", `simulation spends ${-solDelta} lamports, more than allowed ${expected.maxSolOut}`);
  }
  if (expected.minSolIn !== undefined && solDelta < expected.minSolIn) {
    throw new IntegrityError("SOL_IN", `simulation returns ${solDelta} lamports, less than required ${expected.minSolIn}`);
  }
  if (expected.minTokensIn !== undefined && (tokenDelta ?? 0n) < expected.minTokensIn) {
    throw new IntegrityError("TOKENS_IN", `simulation delivers ${tokenDelta} tokens, below minimum ${expected.minTokensIn}`);
  }
  if (expected.maxTokensOut !== undefined && -(tokenDelta ?? 0n) > expected.maxTokensOut) {
    throw new IntegrityError("TOKENS_OUT", "simulation removes more tokens than requested");
  }
  checks.push("balance changes within expected bounds");
  return { postLamports, solDelta, tokenDelta, unitsConsumed: sim.unitsConsumed ?? null, checks };
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
