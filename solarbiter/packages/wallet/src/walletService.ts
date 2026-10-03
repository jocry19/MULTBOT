import fs from "node:fs";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type RpcManager } from "@solarbiter/solana";
import type { Logger } from "pino";
import { Signer } from "./signer.js";

export interface TokenHolding {
  mint: string;
  account: string;
  program: string;
  raw: string;
  decimals: number;
  ui: number;
}

export interface WalletStatus {
  configured: boolean;
  address: string | null;
  lamports: string | null;
  balanceAt: number | null;
  holdings: TokenHolding[];
  loadError: string | null;
}

/**
 * The bot wallet as seen by the rest of the system: address and balances only. The private key is
 * held exclusively by the Signer inside this process (loaded from the encrypted keystore) — it is
 * never returned, logged, stored in the database or sent to the frontend.
 *
 * Without a keystore the wallet is simply "not configured": paper trading works, shadow and live
 * do not.
 */
export class WalletService {
  readonly signer: Signer | null = null;
  readonly loadError: string | null = null;
  lamports: bigint | null = null;
  balanceAt: number | null = null;
  private holdings = new Map<string, TokenHolding>();

  constructor(
    private readonly rpc: RpcManager,
    private readonly log: Logger,
    opts: { keystorePath: string; passphrase: string | undefined },
    private readonly now: () => number = Date.now,
  ) {
    if (!fs.existsSync(opts.keystorePath)) {
      this.loadError = "no keystore configured";
      return;
    }
    if (!opts.passphrase) {
      this.loadError = "keystore found but WALLET_KEYSTORE_PASSPHRASE is not set";
      return;
    }
    try {
      this.signer = Signer.fromKeystore(opts.keystorePath, opts.passphrase);
      this.log.info({ address: this.signer.publicKey }, "bot wallet loaded");
    } catch (err) {
      this.loadError = (err as Error).message;
      this.log.error({ err: this.loadError }, "bot wallet could not be loaded");
    }
  }

  get address(): string | null {
    return this.signer?.publicKey ?? null;
  }

  get configured(): boolean {
    return this.signer !== null;
  }

  /** On-chain SOL and token balances (both token programs). */
  async refresh(): Promise<void> {
    const address = this.address;
    if (!address) return;
    const [lamports, classic, t22] = await Promise.all([
      this.rpc.getBalance(address),
      this.rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID),
      this.rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID),
    ]);
    const next = new Map<string, TokenHolding>();
    for (const [program, list] of [
      [TOKEN_PROGRAM_ID, classic],
      [TOKEN_2022_PROGRAM_ID, t22],
    ] as const) {
      for (const a of list) {
        const info = a.account.data.parsed.info;
        next.set(info.mint, { mint: info.mint, account: a.pubkey, program, raw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals, ui: info.tokenAmount.uiAmount ?? 0 });
      }
    }
    this.lamports = BigInt(lamports);
    this.holdings = next;
    this.balanceAt = this.now();
  }

  hasTokenAccount(mint: string): boolean {
    return this.holdings.has(mint);
  }

  holding(mint: string): TokenHolding | undefined {
    return this.holdings.get(mint);
  }

  status(): WalletStatus {
    return {
      configured: this.configured,
      address: this.address,
      lamports: this.lamports?.toString() ?? null,
      balanceAt: this.balanceAt,
      holdings: [...this.holdings.values()],
      loadError: this.loadError,
    };
  }

  dispose(): void {
    this.signer?.dispose();
  }
}

/**
 * Reconciliation for the BALANCE_MISMATCH breaker: the on-chain balance must equal what the live
 * ledger expects (starting balance + recorded live results + external deposits/withdrawals),
 * within a tolerance for rounding and unrecorded rent refunds.
 */
export function balancesMatch(onChainLamports: bigint, expectedLamports: bigint, toleranceLamports = 10_000n): boolean {
  const d = onChainLamports - expectedLamports;
  return (d < 0n ? -d : d) <= toleranceLamports;
}
