import type { ComponentStatus, ReconciliationState } from "@multbot/shared";
import type { Logger } from "pino";
import { BaseModule } from "../../core/module.js";
import type { Database } from "../../db/database.js";
import type { ActivityLog } from "../activity/activityLog.js";
import type { ExecutionEngine } from "../execution/executionEngine.js";
import type { Ledger } from "../ledger/ledger.js";
import { RECON_STATE_KEY } from "../live/liveEngine.js";
import type { StateStore } from "../system/stateStore.js";
import type { WalletService } from "../wallet/walletService.js";

export interface ReconIssue {
  severity: "critical" | "warning";
  kind: string;
  message: string;
  tradeId?: string;
  mint?: string;
}

/**
 * Crash recovery and periodic reconciliation of the database against the blockchain.
 *
 * On startup (before the live engine starts) and every minute:
 *   1. wallet sync (balances, token accounts, transaction history)
 *   2. resolve orders that were signed/sent but not finished (confirm / expire)
 *   3. finalise or fail live trades stuck in OPENING / CLOSING based on those orders
 *   4. compare open positions with on-chain token balances
 * Any critical mismatch sets RECONCILIATION REQUIRED, which blocks new entries until resolved.
 */
export class Reconciler extends BaseModule {
  issues: ReconIssue[] = [];
  lastRunAt: number | null = null;

  constructor(
    private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly execution: ExecutionEngine,
    private readonly ledger: Ledger,
    private readonly store: StateStore,
    private readonly activity: ActivityLog,
    private readonly onPositionsChanged: () => Promise<void>,
    log: Logger,
  ) {
    super("reconciliation", log);
    this.every("run", 60_000, () => this.run().then(() => undefined));
  }

  protected override async onStart(): Promise<void> {
    await this.run();
  }

  get reconState(): ReconciliationState {
    return this.store.getState<{ state: ReconciliationState }>(RECON_STATE_KEY, { state: "OK" }).state;
  }

  override componentStatus(): ComponentStatus {
    return this.reconState === "OK" ? "CONNECTED" : "DEGRADED";
  }

  override healthDetail(): string {
    return `${this.reconState} issues=${this.issues.length}`;
  }

  async run(): Promise<{ state: ReconciliationState; issues: ReconIssue[] }> {
    if (!this.wallet.signer) {
      this.issues = [];
      return { state: "OK", issues: [] };
    }
    const issues: ReconIssue[] = [];
    await this.wallet.refresh();
    await this.wallet.syncHistory().catch((err) => issues.push({ severity: "warning", kind: "history", message: `history sync failed: ${(err as Error).message}` }));

    // 2. unfinished orders
    const pending = await this.db.many<{ idempotency_key: string; id: string }>("SELECT idempotency_key, id FROM orders WHERE status IN ('SIGNED', 'SENT')");
    for (const o of pending) {
      const r = await this.execution.resume(o.idempotency_key);
      if (r.status === "SENT") issues.push({ severity: "critical", kind: "order_pending", message: `order ${o.id} still unconfirmed` });
    }

    // 3. trades stuck in OPENING / CLOSING
    const stuck = await this.db.many<{ id: string; status: string; mint: string; token_decimals: number | null; strategy_id: string; strategy_version_id: string; wallet: string }>(
      "SELECT id, status, mint, token_decimals, strategy_id, strategy_version_id, wallet FROM live_trades WHERE status IN ('OPENING', 'CLOSING')",
    );
    for (const t of stuck) {
      const orders = await this.db.many<{ kind: string; status: string; signature: string | null; result: { solDeltaLamports?: number; tokenDeltaRaw?: string } | null }>(
        "SELECT kind, status, signature, result FROM orders WHERE live_trade_id = $1 ORDER BY created_at",
        [t.id],
      );
      const buy = orders.find((o) => o.kind === "buy");
      if (t.status === "OPENING") {
        if (buy?.status === "CONFIRMED" && buy.result?.tokenDeltaRaw && BigInt(buy.result.tokenDeltaRaw) > 0n) {
          const spent = -(buy.result.solDeltaLamports ?? 0) / 1e9;
          const tokens = Number(BigInt(buy.result.tokenDeltaRaw)) / 10 ** (t.token_decimals ?? 6);
          await this.db.query(
            "UPDATE live_trades SET status = 'OPEN', opened_at = COALESCE(opened_at, now()), token_qty = $2, gross_entry_sol = $3, entry_price = $4, entry_signature = $5 WHERE id = $1",
            [t.id, buy.result.tokenDeltaRaw, spent, tokens > 0 ? spent / tokens : null, buy.signature],
          );
          await this.ledger.append("ADJUSTMENT", { tradeId: t.id, action: "entry confirmed after restart", signature: buy.signature, solValue: spent }, t.id, buy.signature);
          this.activity.warn("reconciliation", `Recovered live entry ${t.id.slice(0, 8)} confirmed on-chain after restart`, { tradeId: t.id });
        } else if (!buy || ["FAILED", "EXPIRED", "REJECTED"].includes(buy.status)) {
          await this.db.query("UPDATE live_trades SET status = 'FAILED', failed_reason = $2, closed_at = now() WHERE id = $1", [t.id, `entry ${buy?.status ?? "missing"} (reconciled)`]);
        } else {
          issues.push({ severity: "critical", kind: "entry_unknown", message: `entry of trade ${t.id} not resolved yet`, tradeId: t.id });
        }
      } else {
        const sell = [...orders].reverse().find((o) => o.kind === "sell");
        if (sell?.status === "CONFIRMED") {
          issues.push({ severity: "critical", kind: "exit_unfinalized", message: `trade ${t.id} was sold on-chain but not finalised — review required`, tradeId: t.id, mint: t.mint });
        } else {
          await this.db.query("UPDATE live_trades SET status = 'OPEN' WHERE id = $1", [t.id]);
        }
      }
    }

    // 4. positions vs on-chain balances
    const open = await this.db.many<{ id: string; mint: string; token_qty: string | null }>("SELECT id, mint, token_qty FROM live_trades WHERE status = 'OPEN'");
    const expectedByMint = new Map<string, bigint>();
    for (const t of open) expectedByMint.set(t.mint, (expectedByMint.get(t.mint) ?? 0n) + BigInt(t.token_qty ?? "0"));
    for (const [mint, expected] of expectedByMint) {
      const held = this.wallet.holdings.get(mint)?.raw ?? 0n;
      if (held * 1000n < expected * 999n) {
        issues.push({ severity: "critical", kind: "position_missing", message: `DB expects ${expected} raw tokens of ${mint}, wallet holds ${held}`, mint });
      }
    }
    const tradedMints = new Set((await this.db.many<{ mint: string }>("SELECT DISTINCT mint FROM live_trades")).map((r) => r.mint));
    for (const [mint, h] of this.wallet.holdings) {
      if (h.raw > 0n && !expectedByMint.has(mint)) {
        issues.push({
          severity: tradedMints.has(mint) ? "critical" : "warning",
          kind: "untracked_balance",
          message: tradedMints.has(mint) ? `wallet holds ${h.ui} of previously traded ${mint} without an open position` : `wallet holds untracked token ${mint} (e.g. airdrop)`,
          mint,
        });
      }
    }

    const state: ReconciliationState = issues.some((i) => i.severity === "critical") ? "REQUIRED" : "OK";
    const prev = this.reconState;
    await this.store.setState(RECON_STATE_KEY, { state, issues, checkedAt: new Date().toISOString() });
    if (state === "REQUIRED" && prev !== "REQUIRED") {
      this.activity.error("reconciliation", `RECONCILIATION REQUIRED: ${issues.filter((i) => i.severity === "critical").map((i) => i.message).join("; ")}`);
    } else if (state === "OK" && prev === "REQUIRED") {
      this.activity.success("reconciliation", "Reconciliation OK — database matches the blockchain");
    }
    this.issues = issues;
    this.lastRunAt = Date.now();
    await this.onPositionsChanged();
    return { state, issues };
  }

  /** User acknowledges reviewed issues (e.g. after manual intervention). */
  async acknowledge(): Promise<void> {
    await this.store.setState(RECON_STATE_KEY, { state: "OK", issues: [], acknowledgedAt: new Date().toISOString() });
    this.activity.info("reconciliation", "Reconciliation issues acknowledged by user");
  }
}
