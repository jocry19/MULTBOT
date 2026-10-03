import bs58 from "bs58";
import type { DexRegistry } from "@solarbiter/dex";
import type { JitoExecutionAdapter } from "@solarbiter/jito";
import type { Portfolio } from "@solarbiter/paper-engine";
import { closingGuard } from "@solarbiter/profit-engine";
import type { RiskApproval, RiskEngine } from "@solarbiter/risk-engine";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, bps, lamportsToEur, type Opportunity, type Quote, type Settings } from "@solarbiter/shared";
import type { RpcManager } from "@solarbiter/solana";
import { Signer, approve, inspectTransaction, type WalletService } from "@solarbiter/wallet";
import type { Logger } from "pino";
import type { RouteBuilder } from "./builder.js";
import { NotAtomicError } from "./composer.js";

/** Persistence port for execution attempts (idempotency + crash recovery). */
export interface ExecutionJournal {
  /** false if an attempt with this key exists already (never execute twice). */
  begin(key: string, o: Opportunity): Promise<boolean>;
  update(key: string, patch: Record<string, unknown>): Promise<void>;
}

export type LiveOutcome = "CONFIRMED" | "FAILED" | "CANCELLED" | "UNKNOWN";

export interface LiveTradeRecord {
  id: string;
  opportunityId: string;
  outcome: LiveOutcome;
  reason: string | null;
  signature: string | null;
  bundleId: string | null;
  slot: number | null;
  tsDetected: number;
  tsSubmitted: number | null;
  tsConfirmed: number | null;
  sizeEur: number;
  solEur: number;
  inputLamports: bigint;
  expectedNet: bigint;
  /** Final profit check (fresh quotes right before sending). */
  finalCheckNet: bigint | null;
  realizedNet: bigint | null;
  realizedNetEur: number | null;
  feesPaid: bigint | null;
  rentLocked: bigint;
  computeUnitLimit: number | null;
  unitsConsumed: number | null;
  priorityFee: bigint;
  jitoTip: bigint;
  viaJito: boolean;
  predictionErrorBps: number | null;
}

export interface LiveExecutorDeps {
  registry: DexRegistry;
  rpc: RpcManager;
  risk: RiskEngine;
  builder: RouteBuilder;
  wallet: WalletService;
  jito: JitoExecutionAdapter | null;
  journal: ExecutionJournal;
  settings: () => Settings;
  decimals: (mint: string) => number | undefined;
  rentLocked: (o: Opportunity) => bigint;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Share of the approved edge that must survive the final re-quote. */
export const FINAL_CHECK_MIN_SHARE = 0.8;

/**
 * Real-money execution. Every step can only make the trade LESS likely:
 *
 *   risk approval (single use, bound to the opportunity) → idempotency → FINAL PROFIT CHECK on fresh
 *   quotes → build with the closing-leg profit guard → simulation with the wallet → compute-unit
 *   optimisation → static transaction guard → integrity approval → signer → Jito bundle (or RPC)
 *   → landing / confirmation → realised result from the on-chain balance change.
 *
 * It never retries a trade, never re-sends a different transaction for the same opportunity, and
 * never reports a result it did not read from the chain.
 */
export class LiveExecutor {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private inFlight = 0;

  constructor(private readonly d: LiveExecutorDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** Re-quote every leg (priority final) with the amounts the transaction swaps; returns the new final output. */
  private async finalCheck(o: Opportunity): Promise<{ legs: Quote[]; output: bigint }> {
    const legs: Quote[] = [];
    let amount = o.inputAmount;
    for (let i = 0; i < o.legs.length; i++) {
      const leg = o.legs[i] as Quote;
      const adapter = this.d.registry.require(leg.source);
      const inputDecimals = this.d.decimals(leg.inputMint);
      const outputDecimals = this.d.decimals(leg.outputMint);
      if (inputDecimals === undefined || outputDecimals === undefined) throw new Error("unknown decimals");
      const q = await adapter.getQuote({
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        inputDecimals,
        outputDecimals,
        amount,
        slippageBps: leg.slippageBps,
        onlyDirectRoutes: true,
        forJitoBundle: this.d.jito !== null,
        priority: "final",
        maxWaitMs: 1_500,
      });
      legs.push(q);
      const nextIsLast = i + 1 === o.legs.length - 1;
      amount = nextIsLast ? q.outputAmount : q.minOutputAmount;
    }
    return { legs, output: (legs[legs.length - 1] as Quote).outputAmount };
  }

  async execute(o: Opportunity, approval: RiskApproval | null, portfolio: Portfolio): Promise<LiveTradeRecord> {
    const settings = this.d.settings();
    const viaJito = this.d.jito !== null;
    const rent = this.d.rentLocked(o);
    const base = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE);
    const rec: LiveTradeRecord = {
      id: `live_${o.id}`,
      opportunityId: o.id,
      outcome: "CANCELLED",
      reason: null,
      signature: null,
      bundleId: null,
      slot: null,
      tsDetected: o.timestamp,
      tsSubmitted: null,
      tsConfirmed: null,
      sizeEur: o.sizeEur,
      solEur: o.solEur,
      inputLamports: o.inputAmount,
      expectedNet: o.expectedNetProfit,
      finalCheckNet: null,
      realizedNet: null,
      realizedNetEur: null,
      feesPaid: null,
      rentLocked: rent,
      computeUnitLimit: null,
      unitsConsumed: null,
      priorityFee: o.priorityFee,
      jitoTip: o.jitoTip,
      viaJito,
      predictionErrorBps: null,
    };
    const cancel = (reason: string): LiveTradeRecord => ({ ...rec, outcome: "CANCELLED", reason });

    if (o.mode !== "live" || portfolio.mode !== "live") throw new Error("live executor only executes live opportunities on the live portfolio");
    const ok = this.d.risk.consumeApproval(approval, o, this.now());
    if (!ok.ok) return cancel(`risk approval: ${ok.reason}`);
    const signer = this.d.wallet.signer;
    const wallet = this.d.wallet.address;
    if (!signer || !wallet) return cancel("bot wallet not configured");
    if (this.inFlight >= settings.capital.maxConcurrentTrades) return cancel("another live trade is in flight");
    if (!(await this.d.journal.begin(o.id, o))) return cancel("opportunity was already executed (idempotency)");

    this.inFlight++;
    portfolio.open();
    let submitted = false;
    try {
      // FINAL PROFIT CHECK — fresh firm quotes directly before sending
      let fresh: { legs: Quote[]; output: bigint };
      try {
        fresh = await this.finalCheck(o);
      } catch (err) {
        await this.d.journal.update(o.id, { status: "CANCELLED", error: `final check: ${(err as Error).message}` });
        portfolio.abort();
        return cancel(`final profit check failed: ${(err as Error).message}`);
      }
      const costs = base + o.priorityFee + o.jitoTip;
      const freshNet = fresh.output - o.inputAmount - costs - o.expectedSlippage - o.safetyBuffer;
      rec.finalCheckNet = freshNet;
      if (freshNet <= 0n || Number(freshNet) < FINAL_CHECK_MIN_SHARE * Number(o.expectedNetProfit)) {
        await this.d.journal.update(o.id, { status: "CANCELLED", error: "edge vanished at final check", final_check_net: freshNet.toString() });
        portfolio.abort();
        return cancel(`edge vanished at the final check (${freshNet} lamports vs approved ${o.expectedNetProfit})`);
      }
      const updated: Opportunity = { ...o, legs: fresh.legs, outputAmount: fresh.output };
      const guard = closingGuard(updated, settings.strategy.minNetProfitEur);
      if (!guard) {
        portfolio.abort();
        return cancel("profit guard unreachable at final check");
      }

      // BUILD + SIMULATE + CU OPTIMISATION
      await this.d.wallet.refresh();
      const pre = this.d.wallet.lamports;
      if (pre === null) {
        portfolio.abort();
        return cancel("wallet balance unknown");
      }
      let built;
      try {
        built = await this.d.builder.build(updated, wallet, guard, { forSend: true, preLamports: Number(pre), rentLockedLamports: rent });
      } catch (err) {
        const msg = err instanceof NotAtomicError ? `NOT_ATOMIC: ${err.message}` : `SIMULATION_FAILED: ${(err as Error).message}`;
        await this.d.journal.update(o.id, { status: "CANCELLED", error: msg });
        portfolio.abort();
        return cancel(msg);
      }
      rec.computeUnitLimit = built.computeUnitLimit;
      rec.unitsConsumed = built.unitsConsumed;

      // STATIC GUARD → INTEGRITY APPROVAL → SIGN
      const tipAccounts = this.d.jito ? await this.d.jito.tipAccounts() : [];
      const report = inspectTransaction(built.tx, {
        wallet,
        maxPriorityFeeLamports: settings.risk.maxPriorityFeeLamports,
        maxWrapLamports: Number(o.inputAmount),
        tipAccounts,
        maxTipLamports: settings.risk.maxJitoTipLamports,
      });
      if (!built.simulation) throw new Error("simulation report missing");
      const integrity = approve(report, built.simulation, this.now());
      const raw = signer.sign(built.tx, integrity, this.now());
      const signature = Signer.signatureOf(built.tx);
      rec.signature = signature;
      await this.d.journal.update(o.id, { status: "SIGNED", signature, compute_unit_limit: built.computeUnitLimit, units_consumed: built.unitsConsumed });

      // SUBMIT
      const b64 = Buffer.from(raw).toString("base64");
      rec.tsSubmitted = this.now();
      submitted = true;
      let bundleId: string | null = null;
      if (this.d.jito) {
        bundleId = await this.d.jito.submit(this.d.jito.createBundle([b64]));
        rec.bundleId = bundleId;
      } else {
        await this.d.rpc.sendTransaction(b64, { skipPreflight: false });
      }
      await this.d.journal.update(o.id, { status: "SUBMITTED", bundle_id: bundleId, ts_submitted: new Date(rec.tsSubmitted).toISOString() });

      // MONITOR
      if (this.d.jito && bundleId) await this.d.jito.waitForResult(bundleId, 30_000, 1_000);
      const tx = await this.confirmed(signature, 45_000);
      if (!tx) {
        // not seen on chain: with a bundle nothing was paid; via RPC the blockhash expired
        rec.outcome = "UNKNOWN";
        rec.reason = "transaction not found on chain within the timeout";
        await this.d.journal.update(o.id, { status: "UNKNOWN", error: rec.reason });
        portfolio.close({ id: rec.id, mode: "live", closedAt: this.now(), sizeEur: o.sizeEur, netLamports: 0n, netEur: 0, success: null });
        return rec;
      }
      const keys = tx.transaction.message.accountKeys;
      const idx = keys.indexOf(wallet);
      const delta = idx >= 0 && tx.meta ? BigInt((tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0)) : 0n;
      rec.slot = tx.slot;
      rec.tsConfirmed = this.now();
      rec.feesPaid = BigInt(tx.meta?.fee ?? 0);
      // rent of newly created token accounts is locked (refundable), not a trading loss
      const realized = delta + rent;
      rec.realizedNet = realized;
      rec.realizedNetEur = lamportsToEur(realized, o.solEur);
      rec.predictionErrorBps = bps(o.expectedNetProfit - realized, o.inputAmount);
      const success = !tx.meta?.err;
      rec.outcome = success ? "CONFIRMED" : "FAILED";
      rec.reason = success ? null : `on-chain error: ${JSON.stringify(tx.meta?.err)}`;
      await this.d.journal.update(o.id, { status: rec.outcome, slot: tx.slot, realized_net: realized.toString(), fee: rec.feesPaid.toString(), error: rec.reason });
      portfolio.close({ id: rec.id, mode: "live", closedAt: this.now(), sizeEur: o.sizeEur, netLamports: realized, netEur: rec.realizedNetEur, success });
      return rec;
    } catch (err) {
      const msg = (err as Error).message;
      this.d.log.error({ opportunity: o.id, err: msg, submitted }, "live execution error");
      await this.d.journal.update(o.id, { status: submitted ? "UNKNOWN" : "CANCELLED", error: msg }).catch(() => undefined);
      if (submitted) {
        portfolio.close({ id: rec.id, mode: "live", closedAt: this.now(), sizeEur: o.sizeEur, netLamports: 0n, netEur: 0, success: null });
        return { ...rec, outcome: "UNKNOWN", reason: msg };
      }
      portfolio.abort();
      return cancel(msg);
    } finally {
      this.inFlight--;
    }
  }

  /** Poll the signature until confirmed (or the timeout), then read the transaction. */
  private async confirmed(signature: string, timeoutMs: number) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const [st] = await this.d.rpc.getSignatureStatuses([signature]).catch(() => [null]);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        for (let i = 0; i < 5; i++) {
          const tx = await this.d.rpc.getTransaction(signature, "confirmed").catch(() => null);
          if (tx) return tx;
          await this.sleep(1_000);
        }
      }
      await this.sleep(1_500);
    }
    return null;
  }
}

/** base58 signature of the first signature in a serialized transaction. */
export function signatureFromRaw(raw: Uint8Array): string {
  // wire format: compact-u16 count (1 byte for < 128) followed by 64-byte signatures
  return bs58.encode(raw.subarray(1, 65));
}
