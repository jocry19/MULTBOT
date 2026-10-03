import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import type { ComponentStatus, Settings } from "@multbot/shared";
import type { Logger } from "pino";
import { idempotencyKey } from "../../core/hash.js";
import { PermanentError } from "../../core/errors.js";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { ActivityLog } from "../activity/activityLog.js";
import type { ExecutionEngine } from "../execution/executionEngine.js";
import type { Ledger } from "../ledger/ledger.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../pumpfun/constants.js";
import type { RpcManager } from "../solana/rpcManager.js";
import type { TaxLedger } from "../tax/taxLedger.js";
import { Signer } from "./signer.js";

export interface TokenHolding {
  mint: string;
  account: string;
  raw: bigint;
  decimals: number;
  ui: number;
}

/** Minimum balance a plain system account must keep (rent exemption for 0 bytes). */
const RENT_EXEMPT_MIN = 890_880;

/**
 * The bot wallet: address, SOL and token balances, on-chain transaction history (deposits,
 * withdrawals, swaps), and user-initiated SOL transfers (withdrawals) with full validation.
 */
export class WalletService extends BaseModule {
  readonly signer: Signer | null;
  lamports: number | null = null;
  balanceAt: number | null = null;
  holdings = new Map<string, TokenHolding>();
  private lastSignature: string | null = null;
  loadError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly rpc: RpcManager,
    keystorePath: string,
    passphrase: string | undefined,
    private readonly settings: () => Settings,
    private readonly activity: ActivityLog,
    private readonly getLedger: () => Ledger,
    private readonly getTax: () => TaxLedger,
    private readonly getExecution: () => ExecutionEngine,
    log: Logger,
  ) {
    super("wallet", log);
    let signer: Signer | null = null;
    if (fs.existsSync(keystorePath)) {
      if (!passphrase) {
        this.loadError = "keystore found but WALLET_KEYSTORE_PASSPHRASE is not set";
      } else {
        try {
          signer = Signer.fromKeystore(keystorePath, passphrase);
        } catch (err) {
          this.loadError = (err as Error).message;
        }
      }
    } else {
      this.loadError = "no bot wallet keystore (pnpm wallet:create)";
    }
    this.signer = signer;
    if (signer) {
      this.every("balances", 10_000, () => this.refresh(), true);
      this.every("history", 60_000, () => this.syncHistory().then(() => undefined), true);
    }
  }

  get address(): string | null {
    return this.signer?.publicKey ?? null;
  }

  protected override async onStop(): Promise<void> {
    this.signer?.dispose();
  }

  override componentStatus(): ComponentStatus {
    if (!this.signer) return "DISABLED";
    if (this.lamports === null) return "UNKNOWN";
    if (this.balanceAt && Date.now() - this.balanceAt > 60_000) return "DEGRADED";
    return "CONNECTED";
  }

  override healthDetail(): string {
    return this.signer ? `${this.signer.publicKey.slice(0, 6)}… ${this.lamports === null ? "?" : (this.lamports / 1e9).toFixed(4)} SOL` : (this.loadError ?? "no wallet");
  }

  async refresh(): Promise<void> {
    if (!this.signer) return;
    const addr = this.signer.publicKey;
    const bal = await this.rpc.callVerified<{ value: number }>("getBalance", [addr, { commitment: "confirmed" }], (a, b) => Math.abs(a.value - b.value) < 100_000);
    if (bal.mismatch) this.activity.warn("wallet", "RPC endpoints disagree about the wallet balance (possible stale or manipulated response)", {});
    this.lamports = bal.result.value;
    this.balanceAt = Date.now();
    const next = new Map<string, TokenHolding>();
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      for (const acc of await this.rpc.getTokenAccountsByOwner(addr, program)) {
        const info = acc.account.data.parsed.info;
        const raw = BigInt(info.tokenAmount.amount);
        const prev = next.get(info.mint);
        next.set(info.mint, {
          mint: info.mint,
          account: acc.pubkey,
          raw: (prev?.raw ?? 0n) + raw,
          decimals: info.tokenAmount.decimals,
          ui: (prev?.ui ?? 0) + (info.tokenAmount.uiAmount ?? 0),
        });
      }
    }
    this.holdings = next;
  }

  /** Import new on-chain transactions of the bot wallet (deposits, withdrawals, swaps). */
  async syncHistory(): Promise<number> {
    if (!this.signer) return 0;
    const addr = this.signer.publicKey;
    if (this.lastSignature === null) {
      const last = await this.db.one<{ signature: string }>("SELECT signature FROM transactions WHERE wallet = $1 ORDER BY slot DESC LIMIT 1", [addr]);
      this.lastSignature = last?.signature ?? null;
    }
    const sigs = await this.rpc.getSignaturesForAddress(addr, { limit: 200, ...(this.lastSignature ? { until: this.lastSignature } : {}) });
    let n = 0;
    for (const s of [...sigs].reverse()) {
      const tx = await this.rpc.getTransaction(s.signature);
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys;
      const idx = keys.indexOf(addr);
      const delta = idx >= 0 ? (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0) : 0;
      const fee = idx === 0 ? tx.meta.fee : 0;
      const tokenChanges = new Map<string, bigint>();
      for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === addr) tokenChanges.set(b.mint, BigInt(b.uiTokenAmount.amount));
      for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === addr) tokenChanges.set(b.mint, (tokenChanges.get(b.mint) ?? 0n) - BigInt(b.uiTokenAmount.amount));
      const changed = [...tokenChanges.entries()].filter(([, v]) => v !== 0n);
      const order = await this.db.one<{ id: string; kind: string; live_trade_id: string | null }>("SELECT id, kind, live_trade_id FROM orders WHERE signature = $1", [s.signature]);
      let type = "other";
      let counterparty: string | null = null;
      if (order) type = order.kind === "buy" ? "swap_buy" : order.kind === "sell" ? "swap_sell" : "withdrawal";
      else if (changed.length === 0 && delta > 0) {
        type = "deposit";
        const payerIdx = tx.meta.preBalances.findIndex((pre, i) => i !== idx && (tx.meta?.postBalances[i] ?? 0) < pre);
        counterparty = payerIdx >= 0 ? (keys[payerIdx] ?? null) : null;
      } else if (changed.length === 0 && delta < 0) type = "withdrawal";
      const [firstChange] = changed;
      const ins = await this.db.query(
        `INSERT INTO transactions (signature, wallet, slot, ts, type, status, sol_change_lamports, fee_lamports, token_mint, token_change, counterparty, order_id, live_trade_id, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (signature) DO NOTHING`,
        [
          s.signature,
          addr,
          tx.slot,
          tx.blockTime ? new Date(tx.blockTime * 1000) : null,
          type,
          tx.meta.err ? "failed" : "success",
          delta,
          fee,
          firstChange?.[0] ?? null,
          firstChange?.[1].toString() ?? null,
          counterparty,
          order?.id ?? null,
          order?.live_trade_id ?? null,
          JSON.stringify({ tokenChanges: changed.map(([m, v]) => [m, v.toString()]) }),
        ],
      );
      if ((ins.rowCount ?? 0) > 0) {
        n++;
        if (type === "deposit" && !tx.meta.err) {
          const sol = delta / 1e9;
          const ts = new Date((tx.blockTime ?? Date.now() / 1000) * 1000);
          await this.getLedger().append("DEPOSIT", { signature: s.signature, wallet: addr, solValue: sol, from: counterparty, timestamp: ts.toISOString() }, null, s.signature);
          await this.getTax().recordDeposit(ts, sol, s.signature, null);
          this.activity.success("wallet", `Deposit received: ${sol.toFixed(4)} SOL`, { signature: s.signature });
        }
      }
      this.lastSignature = s.signature;
    }
    return n;
  }

  /** Withdraw SOL to an external address (user action). */
  async sendSol(destination: string, amountSol: number, openPositions: number): Promise<{ signature: string | null; status: string; error: string | null }> {
    if (!this.signer) throw new PermanentError("NO_WALLET", "bot wallet not configured");
    let dest: PublicKey;
    try {
      dest = new PublicKey(destination);
    } catch {
      throw new PermanentError("INVALID_ADDRESS", "destination is not a valid Solana address");
    }
    if (!PublicKey.isOnCurve(dest.toBytes())) throw new PermanentError("INVALID_ADDRESS", "destination is a program-derived address, not a wallet");
    if (dest.toBase58() === this.signer.publicKey) throw new PermanentError("INVALID_ADDRESS", "cannot send to the bot wallet itself");
    if (!(amountSol > 0)) throw new PermanentError("INVALID_AMOUNT", "amount must be positive");
    await this.refresh();
    const lamports = Math.round(amountSol * 1e9);
    const balance = this.lamports ?? 0;
    const keep = openPositions > 0 ? Math.max(RENT_EXEMPT_MIN, Math.floor(this.settings().risk.minWalletReserveSol * 1e9)) : RENT_EXEMPT_MIN;
    if (balance - lamports - 5_000 < keep) {
      throw new PermanentError("INSUFFICIENT_SOL", `amount too high: balance ${(balance / 1e9).toFixed(6)} SOL, must keep ${(keep / 1e9).toFixed(6)} SOL${openPositions > 0 ? " (open positions need a reserve for exits)" : ""}`);
    }
    const r = await this.getExecution().execute({
      idempotencyKey: idempotencyKey("withdraw", dest.toBase58(), lamports, Math.floor(Date.now() / 60_000)),
      liveTradeId: null,
      kind: "transfer",
      amount: BigInt(lamports),
      maxSlippageBps: 0,
      destination: dest.toBase58(),
    });
    if (r.status === "CONFIRMED" && r.signature) {
      await this.getLedger().append("WITHDRAWAL", { signature: r.signature, wallet: this.signer.publicKey, to: dest.toBase58(), solValue: amountSol, feeLamports: r.feeLamports }, null, r.signature);
      await this.getTax().recordWithdrawal(new Date(), amountSol, r.signature);
      this.activity.info("wallet", `Withdrawal sent: ${amountSol} SOL → ${dest.toBase58().slice(0, 6)}…`, { signature: r.signature });
      await this.refresh();
    }
    return { signature: r.signature, status: r.status, error: r.error };
  }
}
