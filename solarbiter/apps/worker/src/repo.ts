import type { Database, Queryable } from "@solarbiter/database";
import type { LiveTradeRecord } from "@solarbiter/execution-engine";
import type { LearningSample } from "@solarbiter/learning-engine";
import type { ClosedTrade, PaperTradeRecord } from "@solarbiter/paper-engine";
import { stringifyBig, type ExecutionFeatures, type NotificationDto, type Opportunity, type PoolInfo, type Quote, type Settings, type TokenInfo, type TradeMode } from "@solarbiter/shared";
import type { Lot, TaxRow } from "@solarbiter/tax";

const j = (v: unknown): string => stringifyBig(v);
const iso = (t: number | null | undefined): string | null => (t === null || t === undefined ? null : new Date(t).toISOString());

/** All database writes/reads of the worker in one place (SQL uses only trusted identifiers). */
export class Repo {
  constructor(readonly db: Database) {}

  // --- market data --------------------------------------------------------------------------------
  async upsertTokens(tokens: TokenInfo[]): Promise<void> {
    for (const t of tokens) {
      await this.db.query(
        `INSERT INTO tokens (mint, symbol, name, decimals, program, mint_authority, freeze_authority, allowlisted, denylisted, safe, safety_reasons, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (mint) DO UPDATE SET symbol=EXCLUDED.symbol, name=EXCLUDED.name, decimals=EXCLUDED.decimals, program=EXCLUDED.program,
           mint_authority=EXCLUDED.mint_authority, freeze_authority=EXCLUDED.freeze_authority, allowlisted=EXCLUDED.allowlisted,
           denylisted=EXCLUDED.denylisted, safe=EXCLUDED.safe, safety_reasons=EXCLUDED.safety_reasons, checked_at=now()`,
        [t.mint, t.symbol, t.name, t.decimals, t.program || null, t.mintAuthority, t.freezeAuthority, t.allowlisted, t.denylisted, t.safe, j(t.safetyReasons)],
      );
    }
  }

  async upsertPools(pools: PoolInfo[]): Promise<void> {
    await this.db.tx(async (c) => {
      for (const p of pools) {
        await c.query(
          `INSERT INTO pools (address, dex, kind, program_id, label, mint_a, mint_b, decimals_a, decimals_b, vault_a, vault_b, fee_rate, tvl_usd, extra, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
           ON CONFLICT (address) DO UPDATE SET fee_rate=EXCLUDED.fee_rate, tvl_usd=EXCLUDED.tvl_usd, extra=EXCLUDED.extra, vault_a=EXCLUDED.vault_a, vault_b=EXCLUDED.vault_b, active=true`,
          [p.address, p.dex, p.kind, p.programId, p.label, p.mintA, p.mintB, p.decimalsA, p.decimalsB, p.vaultA, p.vaultB, p.feeRate, p.tvlUsd, j(p.extra)],
        );
      }
      await c.query("UPDATE pools SET active = false WHERE NOT (address = ANY($1::text[]))", [pools.map((p) => p.address)]);
    });
  }

  async loadPools(): Promise<PoolInfo[]> {
    const rows = await this.db.many<Record<string, unknown>>("SELECT * FROM pools WHERE active ORDER BY tvl_usd DESC");
    return rows.map((r) => ({
      address: r.address as string,
      dex: r.dex as PoolInfo["dex"],
      kind: r.kind as PoolInfo["kind"],
      programId: r.program_id as string,
      label: r.label as string,
      mintA: r.mint_a as string,
      mintB: r.mint_b as string,
      decimalsA: Number(r.decimals_a),
      decimalsB: Number(r.decimals_b),
      vaultA: (r.vault_a as string | null) ?? null,
      vaultB: (r.vault_b as string | null) ?? null,
      feeRate: Number(r.fee_rate),
      tvlUsd: Number(r.tvl_usd),
      extra: (r.extra as Record<string, string>) ?? {},
    }));
  }

  async insertPriorityFees(s: { ts: number; slot: number | null; p25: number; p50: number; p75: number; p90: number; max: number; samples: number }): Promise<void> {
    await this.db.query("INSERT INTO priority_fees (ts, slot, p25, p50, p75, p90, max, samples) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [iso(s.ts), s.slot, s.p25, s.p50, s.p75, s.p90, s.max, s.samples]);
  }

  async insertFx(price: number, ts: number, source: string): Promise<void> {
    await this.db.query("INSERT INTO fx_rates (pair, ts, price, source) VALUES ('SOL/EUR', $1, $2, $3) ON CONFLICT DO NOTHING", [iso(ts), price, source]);
  }

  // --- opportunities ------------------------------------------------------------------------------
  async insertOpportunity(o: Opportunity, features: ExecutionFeatures | null): Promise<void> {
    await this.db.query(
      `INSERT INTO opportunities (id, ts, slot, mode, strategy_type, strategy_version_id, route, route_dexes, input_mint, output_mint, token_mint, source_dex, destination_dex,
        input_amount, output_amount, size_eur, sol_eur, gross_profit, gross_profit_percent, dex_fees, network_fee, priority_fee, jito_tip, price_impact, expected_slippage,
        execution_probability, expected_failure_cost, safety_buffer, expected_net_profit, expected_net_profit_percent, expected_net_profit_eur, quote_age_ms, latency_estimate_ms,
        atomic, status, rejection_reason, rejection_detail, costs, size_ladder, decision_log, legs, features)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
       ON CONFLICT DO NOTHING`,
      [
        o.id, iso(o.timestamp), o.slot, o.mode, o.strategyType, o.strategyVersionId, j(o.route), o.routeDexes, o.inputMint, o.outputMint, o.tokenMint, o.sourceDex, o.destinationDex,
        o.inputAmount, o.outputAmount, o.sizeEur, o.solEur, o.grossProfit, o.grossProfitPercent, o.dexFees, o.networkFee, o.priorityFee, o.jitoTip, o.priceImpact, o.expectedSlippage,
        o.executionProbability, o.expectedFailureCost, o.safetyBuffer, o.expectedNetProfit, o.expectedNetProfitPercent, o.expectedNetProfitEur, Math.round(o.quoteAge), Math.round(o.latencyEstimate),
        o.atomic, o.status, o.rejectionReason, o.rejectionDetail, o.costs ? j(o.costs) : null, j(o.sizeLadder), j(o.decisionLog), j(o.legs.map(stripRaw)), j(features ?? {}),
      ],
    );
  }

  async updateOpportunityStatus(id: string, ts: number, status: string, reason: string | null, detail: string | null): Promise<void> {
    await this.db.query("UPDATE opportunities SET status = $3, rejection_reason = COALESCE($4, rejection_reason), rejection_detail = COALESCE($5, rejection_detail) WHERE id = $1 AND ts = $2", [id, iso(ts), status, reason, detail]);
  }

  async insertQuotes(legs: Quote[], opportunityId: string, purpose: string): Promise<void> {
    if (!legs.length) return;
    await this.db.insertMany(
      "quotes",
      ["id", "ts", "slot", "kind", "source", "input_mint", "output_mint", "input_amount", "output_amount", "min_output", "slippage_bps", "price", "price_impact", "fee_rates", "route", "latency_ms", "opportunity_id", "purpose"],
      legs.map((q) => [q.id, iso(q.timestamp), q.slot, q.kind, q.source, q.inputMint, q.outputMint, q.inputAmount, q.outputAmount, q.minOutputAmount, q.slippageBps, q.price, q.priceImpact, j(q.feeRates), j(q.route), Math.round(q.latencyMs), opportunityId, purpose]),
      "ON CONFLICT DO NOTHING",
    );
  }

  async addNoTradeStats(bucket: number, reason: string, strategyType: string, count: number): Promise<void> {
    if (count <= 0) return;
    await this.db.query(
      `INSERT INTO no_trade_stats (bucket, reason, strategy_type, count) VALUES ($1,$2,$3,$4)
       ON CONFLICT (bucket, reason, strategy_type) DO UPDATE SET count = no_trade_stats.count + EXCLUDED.count`,
      [iso(bucket - (bucket % 60_000)), reason, strategyType, count],
    );
  }

  async countOpportunities(mode: TradeMode): Promise<number> {
    const r = await this.db.one<{ n: string }>("SELECT count(*)::text AS n FROM opportunities WHERE mode = $1", [mode]);
    return Number(r?.n ?? 0);
  }

  // --- trades --------------------------------------------------------------------------------------
  async insertPaperTrade(r: PaperTradeRecord, learning: LearningSample | null): Promise<void> {
    await this.db.query(
      `INSERT INTO paper_trades (id, opportunity_id, strategy_version_id, shadow, ts_detected, ts_executed, ts_closed, latency_ms, size_eur, sol_eur, input_lamports, detected_output,
        expected_output, min_output, simulated_output, slippage_lamports, fees, predicted_net, realized_net, realized_net_eur, success, failure_reason, prediction_error_bps, route, simulation, status, learning)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        r.id, r.opportunityId, r.strategyVersionId, r.shadow, iso(r.tsDetected), iso(r.tsExecuted), iso(r.tsClosed), r.latencyMs, r.sizeEur, r.solEur, r.inputLamports, r.detectedOutput,
        r.expectedOutput, r.minOutput, r.simulatedOutput, r.slippageLamports, j(r.fees), r.predictedNet, r.realizedNet, r.realizedNetEur, r.success, r.failureReason, r.predictionErrorBps,
        j({ ...r.route, stages: r.stages }), r.simulation ? j(r.simulation) : null, r.status, learning ? j(learning) : null,
      ],
    );
    if (r.fees.paid) {
      await this.insertFees("paper", r.solEur, { paperTradeId: r.id }, [
        ["base", BigInt(r.fees.baseLamports)],
        ["priority", BigInt(r.fees.priorityLamports)],
        ["jito", BigInt(r.fees.jitoTipLamports)],
      ]);
    }
  }

  async insertLiveTrade(r: LiveTradeRecord, o: Opportunity, level: number, minOutput: bigint, learning: LearningSample | null): Promise<void> {
    const status = r.outcome === "CANCELLED" ? "REJECTED" : r.outcome === "UNKNOWN" ? "SUBMITTED" : r.outcome;
    await this.db.query(
      `INSERT INTO live_trades (id, opportunity_id, strategy_version_id, live_level, ts_detected, ts_submitted, ts_confirmed, size_eur, sol_eur, input_lamports, predicted_output, min_output,
        sol_delta, fees, predicted_net, realized_net, realized_net_eur, prediction_error_bps, status, failure_reason, signature, bundle_id, via, route, learning)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, realized_net=EXCLUDED.realized_net, realized_net_eur=EXCLUDED.realized_net_eur,
         ts_confirmed=EXCLUDED.ts_confirmed, sol_delta=EXCLUDED.sol_delta, learning=EXCLUDED.learning`,
      [
        r.id, r.opportunityId, o.strategyVersionId, level, iso(r.tsDetected), iso(r.tsSubmitted), iso(r.tsConfirmed), r.sizeEur, r.solEur, r.inputLamports, o.outputAmount, minOutput,
        r.realizedNet === null ? null : r.realizedNet - r.rentLocked,
        j({ base: "5000", priority: r.priorityFee.toString(), jitoTip: r.jitoTip.toString(), paidTotal: r.feesPaid?.toString() ?? null, rentLocked: r.rentLocked.toString(), cuLimit: r.computeUnitLimit, unitsConsumed: r.unitsConsumed, finalCheckNet: r.finalCheckNet?.toString() ?? null }),
        r.expectedNet, r.realizedNet, r.realizedNetEur, r.predictionErrorBps, status, r.reason, r.signature, r.bundleId, r.viaJito ? "jito" : "rpc",
        j({ mints: o.route, dexes: o.routeDexes, legs: o.legs.map(stripRaw) }), learning ? j(learning) : null,
      ],
    );
    if (r.signature && r.outcome !== "CANCELLED") {
      await this.db.query(
        `INSERT INTO transactions (signature, ts, slot, type, status, wallet, sol_change_lamports, fee_lamports, route, input_desc, output_desc, profit_lamports, live_trade_id)
         VALUES ($1,$2,$3,'arbitrage',$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (signature) DO UPDATE SET status = EXCLUDED.status, slot = EXCLUDED.slot, sol_change_lamports = EXCLUDED.sol_change_lamports`,
        [
          r.signature, iso(r.tsConfirmed ?? r.tsSubmitted), r.slot, r.outcome === "CONFIRMED" ? "Confirmed" : r.outcome === "FAILED" ? "Failed" : "Submitted", "bot",
          r.realizedNet === null ? null : r.realizedNet - r.rentLocked, r.feesPaid, j({ mints: o.route, dexes: o.routeDexes }), `${r.inputLamports} lamports SOL`, `${o.outputAmount} lamports SOL (expected)`, r.realizedNet, r.id,
        ],
      );
    }
    if (r.bundleId) {
      await this.db.query(
        `INSERT INTO jito_bundles (bundle_id, live_trade_id, tip_lamports, tip_account, status, landed_slot) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bundle_id) DO UPDATE SET status = EXCLUDED.status, landed_slot = EXCLUDED.landed_slot`,
        [r.bundleId, r.id, Number(r.jitoTip), "random", r.outcome === "CONFIRMED" ? "Landed" : r.outcome === "FAILED" ? "Failed" : "timeout", r.slot],
      );
    }
    if (r.outcome === "CONFIRMED" || r.outcome === "FAILED") {
      await this.insertFees("live", r.solEur, { liveTradeId: r.id, signature: r.signature }, [
        ["base+priority+tip (paid)", r.feesPaid ?? 0n],
        ["rent_locked", r.rentLocked],
      ]);
    }
  }

  private async insertFees(mode: TradeMode, solEur: number, ref: { liveTradeId?: string; paperTradeId?: string; signature?: string | null }, parts: [string, bigint][]): Promise<void> {
    const rows = parts.filter(([, v]) => v > 0n).map(([k, v]) => [mode, k, v, (Number(v) / 1e9) * solEur, ref.liveTradeId ?? null, ref.paperTradeId ?? null, ref.signature ?? null]);
    await this.db.insertMany("fees", ["mode", "kind", "amount_lamports", "eur", "live_trade_id", "paper_trade_id", "signature"], rows);
  }

  async loadClosedTrades(mode: TradeMode): Promise<ClosedTrade[]> {
    if (mode === "paper") {
      const rows = await this.db.many<{ id: string; ts_closed: Date; size_eur: number; realized_net: string | null; realized_net_eur: number | null; success: boolean | null }>(
        "SELECT id, ts_closed, size_eur, realized_net, realized_net_eur, success FROM paper_trades WHERE ts_closed IS NOT NULL ORDER BY ts_closed",
      );
      return rows.map((r) => ({ id: r.id, mode, closedAt: r.ts_closed.getTime(), sizeEur: r.size_eur, netLamports: BigInt(r.realized_net ?? 0), netEur: r.realized_net_eur ?? 0, success: r.success }));
    }
    const rows = await this.db.many<{ id: string; ts: Date; size_eur: number; realized_net: string | null; realized_net_eur: number | null; status: string }>(
      "SELECT id, COALESCE(ts_confirmed, ts_submitted, ts_detected) AS ts, size_eur, realized_net, realized_net_eur, status FROM live_trades WHERE status IN ('CONFIRMED','FAILED') ORDER BY ts",
    );
    return rows.map((r) => ({ id: r.id, mode, closedAt: r.ts.getTime(), sizeEur: r.size_eur, netLamports: BigInt(r.realized_net ?? 0), netEur: r.realized_net_eur ?? 0, success: r.status === "CONFIRMED" }));
  }

  async loadLearningSamples(limit = 50_000): Promise<LearningSample[]> {
    const rows = await this.db.many<{ learning: LearningSample }>(
      `SELECT learning FROM (
         SELECT learning, ts_closed AS ts FROM paper_trades WHERE learning IS NOT NULL
         UNION ALL SELECT learning, COALESCE(ts_confirmed, ts_detected) AS ts FROM live_trades WHERE learning IS NOT NULL
       ) x ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.learning).reverse();
  }

  async paperNetByVersion(versionId: string): Promise<number[]> {
    const rows = await this.db.many<{ v: number | null }>("SELECT realized_net_eur AS v FROM paper_trades WHERE strategy_version_id = $1 AND success IS NOT NULL ORDER BY ts_closed", [versionId]);
    return rows.map((r) => r.v ?? 0);
  }

  // --- execution journal -----------------------------------------------------------------------------
  async beginAttempt(key: string, o: Opportunity): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO execution_attempts (id, idempotency_key, mode, opportunity_id, stage, status, priority_fee_lamports, jito_tip_lamports)
       VALUES ($1,$1,$2,$3,'quote','DETECTED',$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, o.mode, o.id, Number(o.priorityFee), Number(o.jitoTip)],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async updateAttempt(key: string, patch: Record<string, unknown>): Promise<void> {
    const status = String(patch.status ?? "");
    const mapped = ({ SIGNED: ["sign", "SIMULATED"], SUBMITTED: ["submit", "SUBMITTED"], CONFIRMED: ["done", "CONFIRMED"], FAILED: ["done", "FAILED"], CANCELLED: ["done", "REJECTED"], UNKNOWN: ["confirm", "SUBMITTED"] } as Record<string, [string, string]>)[status];
    await this.db.query(
      `UPDATE execution_attempts SET stage = COALESCE($2, stage), status = COALESCE($3, status), signature = COALESCE($4, signature), bundle_id = COALESCE($5, bundle_id),
         cu_limit = COALESCE($6, cu_limit), error = COALESCE($7, error), slot = COALESCE($8, slot),
         submitted_at = CASE WHEN $3 = 'SUBMITTED' AND submitted_at IS NULL THEN now() ELSE submitted_at END,
         confirmed_at = CASE WHEN $3 IN ('CONFIRMED','FAILED') THEN now() ELSE confirmed_at END,
         checks = COALESCE(checks, '{}'::jsonb) || $9::jsonb
       WHERE idempotency_key = $1`,
      [key, mapped?.[0] ?? null, mapped?.[1] ?? null, (patch.signature as string) ?? null, (patch.bundle_id as string) ?? null, (patch.compute_unit_limit as number) ?? null, (patch.error as string) ?? null, (patch.slot as number) ?? null, j(patch)],
    );
  }

  // --- risk, events, learning, notifications -----------------------------------------------------------
  async riskEvent(kind: string, severity: string, message: string, extra: { breaker?: string | null; mode?: string | null; data?: unknown } = {}): Promise<void> {
    await this.db.query("INSERT INTO risk_events (kind, severity, breaker, mode, message, data) VALUES ($1,$2,$3,$4,$5,$6)", [kind, severity, extra.breaker ?? null, extra.mode ?? null, message, extra.data === undefined ? null : j(extra.data)]);
  }

  async systemEvent(level: string, category: string, message: string, data?: unknown): Promise<void> {
    await this.db.query("INSERT INTO system_events (level, category, message, data) VALUES ($1,$2,$3,$4)", [level, category, message, data === undefined ? null : j(data)]);
  }

  async learningMetric(kind: string, value: unknown, versionId: string | null): Promise<void> {
    await this.db.query("INSERT INTO learning_metrics (kind, strategy_version_id, value) VALUES ($1,$2,$3)", [kind, versionId, j(value)]);
  }

  async storeNotification(n: { type: string; severity: string; title: string; message: string; data?: Record<string, unknown> | null }): Promise<NotificationDto> {
    const r = await this.db.one<{ id: string; ts: Date }>("INSERT INTO notifications (type, severity, title, message, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, ts", [n.type, n.severity, n.title, n.message, n.data ? j(n.data) : null]);
    return { id: Number(r?.id ?? 0), ts: (r?.ts ?? new Date()).toISOString(), type: n.type as NotificationDto["type"], severity: n.severity as NotificationDto["severity"], title: n.title, message: n.message, data: n.data ?? null, read: false };
  }

  async markWebhook(id: number, delivered: boolean): Promise<void> {
    await this.db.query("UPDATE notifications SET webhook_delivered = $2 WHERE id = $1", [id, delivered]);
  }

  // --- strategy versions ---------------------------------------------------------------------------------
  async ensureInitialVersion(strategy: Settings["strategy"]): Promise<string> {
    const existing = await this.db.one<{ id: string }>("SELECT id FROM strategy_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1");
    if (existing) return existing.id;
    const any = await this.db.one<{ id: string }>("SELECT id FROM strategy_versions ORDER BY version DESC LIMIT 1");
    if (any) {
      await this.db.query("UPDATE strategy_versions SET status = 'active', activated_at = now() WHERE id = $1", [any.id]);
      return any.id;
    }
    await this.createVersion(1, null, strategy, "seed", "initial strategy (defaults / user settings)", "active");
    return "strategy_v1";
  }

  async createVersion(version: number, parentId: string | null, strategy: Settings["strategy"], createdBy: string, notes: string, status: string, performance: unknown = {}): Promise<string> {
    const id = `strategy_v${version}`;
    await this.db.tx(async (c: Queryable) => {
      await c.query(
        `INSERT INTO strategy_versions (id, version, parent_id, status, created_by, performance, notes, activated_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4 = 'active' THEN now() ELSE NULL END)`,
        [id, version, parentId, status, createdBy, j(performance), notes],
      );
      for (const [k, v] of Object.entries(strategy)) await c.query("INSERT INTO strategy_parameters (strategy_version_id, key, value) VALUES ($1,$2,$3)", [id, k, j(v)]);
    });
    return id;
  }

  async nextVersionNumber(): Promise<number> {
    const r = await this.db.one<{ v: number | null }>("SELECT max(version) AS v FROM strategy_versions");
    return (r?.v ?? 0) + 1;
  }

  async versionParams(id: string): Promise<Record<string, unknown>> {
    const rows = await this.db.many<{ key: string; value: unknown }>("SELECT key, value FROM strategy_parameters WHERE strategy_version_id = $1", [id]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async version(id: string): Promise<{ id: string; version: number; parent_id: string | null; status: string; activated_at: Date | null } | null> {
    return this.db.one("SELECT id, version, parent_id, status, activated_at FROM strategy_versions WHERE id = $1", [id]);
  }

  async setVersionStatus(id: string, status: string, notes?: string): Promise<void> {
    await this.db.query(
      `UPDATE strategy_versions SET status = $2, notes = COALESCE($3, notes),
         retired_at = CASE WHEN $2 IN ('retired','rolled_back') THEN now() ELSE retired_at END,
         activated_at = CASE WHEN $2 = 'active' THEN now() ELSE activated_at END WHERE id = $1`,
      [id, status, notes ?? null],
    );
  }

  // --- wallet & tax -----------------------------------------------------------------------------------
  async upsertWallet(address: string, lamports: bigint | null, tokens: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO wallets (address, last_balance_lamports, last_balance_at, token_balances) VALUES ($1,$2,now(),$3)
       ON CONFLICT (address) DO UPDATE SET last_balance_lamports = EXCLUDED.last_balance_lamports, last_balance_at = now(), token_balances = EXCLUDED.token_balances`,
      [address, lamports, j(tokens)],
    );
  }

  async balanceCheck(wallet: string, onchain: bigint, expected: bigint | null, matched: boolean, note: string | null): Promise<void> {
    await this.db.query("INSERT INTO balance_checks (wallet, onchain_lamports, expected_lamports, matched, note) VALUES ($1,$2,$3,$4,$5)", [wallet, onchain, expected, matched, note]);
  }

  async lastBalanceBaseline(wallet: string): Promise<{ lamports: bigint; ts: number } | null> {
    const r = await this.db.one<{ onchain_lamports: string; ts: Date }>("SELECT onchain_lamports, ts FROM balance_checks WHERE wallet = $1 AND matched ORDER BY ts DESC LIMIT 1", [wallet]);
    return r ? { lamports: BigInt(r.onchain_lamports), ts: r.ts.getTime() } : null;
  }

  async liveDeltaSince(ts: number): Promise<bigint> {
    const r = await this.db.one<{ s: string | null }>("SELECT sum(sol_delta)::text AS s FROM live_trades WHERE sol_delta IS NOT NULL AND COALESCE(ts_confirmed, ts_detected) > $1", [iso(ts)]);
    return BigInt(r?.s ?? 0);
  }

  async loadTaxLots(): Promise<Lot[]> {
    const rows = await this.db.many<{ id: string; asset: string; acquired_at: Date; quantity: string; remaining: string; cost_eur: number | null; source: Lot["source"]; signature: string | null; notes: string | null }>("SELECT * FROM tax_lots ORDER BY acquired_at, id");
    return rows.map((r) => ({ id: r.notes?.startsWith("lot_") ? r.notes : String(r.id), asset: r.asset, acquiredAt: r.acquired_at.getTime(), quantity: BigInt(r.quantity), remaining: BigInt(r.remaining), costEur: r.cost_eur, source: r.source, signature: r.signature }));
  }

  async saveTax(rows: TaxRow[], lots: Lot[]): Promise<void> {
    await this.db.tx(async (c) => {
      for (const l of lots) {
        const upd = await c.query("UPDATE tax_lots SET remaining = $2 WHERE notes = $1", [l.id, l.remaining]);
        if ((upd.rowCount ?? 0) === 0) {
          await c.query("INSERT INTO tax_lots (asset, acquired_at, quantity, remaining, cost_eur, source, signature, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [l.asset, iso(l.acquiredAt), l.quantity, l.remaining, l.costEur, l.source, l.signature, l.id]);
        }
      }
      for (const r of rows) {
        await c.query(
          `INSERT INTO tax_transactions (ts, signature, wallet_address, kind, asset_in, amount_in, asset_in_decimals, asset_out, amount_out, asset_out_decimals, eur_value, eur_price, eur_price_ts,
             fees, fee_currency, fee_eur, acquisition_value_eur, disposal_value_eur, realized_pnl_eur, dex, route, live_trade_id, lot_details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            iso(r.ts), r.signature, r.walletAddress, r.kind, r.assetIn, r.amountIn, r.assetInDecimals, r.assetOut, r.amountOut, r.assetOutDecimals, r.eurValue, r.eurPrice, iso(r.eurPriceTs),
            r.fees, r.feeCurrency, r.feeEur, r.acquisitionValueEur, r.disposalValueEur, r.realizedPnlEur, r.dex, r.route ? j(r.route) : null, r.liveTradeId, r.lotDetails ? j(r.lotDetails) : null,
          ],
        );
      }
    });
  }
}

/** Quotes are stored without the provider's raw payload (large; not needed for audit). */
function stripRaw(q: Quote): Omit<Quote, "raw"> {
  const { raw: _raw, ...rest } = q;
  return rest;
}
