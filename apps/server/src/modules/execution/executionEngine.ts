import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { OrderStatus, Settings } from "@multbot/shared";
import type { Logger } from "pino";
import type { Clock } from "../../core/clock.js";
import { sleep } from "../../core/clock.js";
import { IntegrityError, PermanentError, errorMessage } from "../../core/errors.js";
import { metrics } from "../../core/metrics.js";
import type { Database } from "../../db/database.js";
import { LAMPORTS_PER_SIGNATURE, TOKEN_2022_PROGRAM_ID, TOKEN_ACCOUNT_RENT_LAMPORTS, TOKEN_PROGRAM_ID, WSOL_MINT } from "../pumpfun/constants.js";
import type { RpcManager, RpcTransaction } from "../solana/rpcManager.js";
import { Signer } from "../wallet/signer.js";
import type { SwapProvider, SwapQuote } from "./providers.js";
import {
  MAINNET_GENESIS_HASH,
  approve,
  associatedTokenAddress,
  checkSimulation,
  decodeTransaction,
  inspectTransaction,
  type ExpectedEffect,
  type GuardPolicy,
} from "./txGuard.js";

/**
 * Live execution: quote → cost estimate → static integrity checks → simulation → sign → persist
 * signature → send → confirm (bounded rebroadcast until blockhash expiry) → parse the ACTUAL result.
 *
 * Idempotency: every order has a unique idempotency key. Re-running execute() with the same key
 * resumes the existing order instead of creating a second transaction. A buy whose outcome is
 * unknown is never re-sent as a new transaction before its blockhash has provably expired.
 */

export type ExecutionKind = "buy" | "sell" | "transfer" | "close";

export interface ExecuteRequest {
  idempotencyKey: string;
  liveTradeId: string | null;
  kind: ExecutionKind;
  mint?: string;
  /** buy: lamports to spend; sell: raw token amount; transfer: lamports */
  amount: bigint;
  maxSlippageBps: number;
  destination?: string;
}

export interface ExecutionResult {
  orderId: string;
  status: OrderStatus;
  signature: string | null;
  /** Actual wallet lamport change (negative = spent), including network + priority fees. */
  solDeltaLamports: number | null;
  /** Actual raw token change of the wallet for the mint. */
  tokenDeltaRaw: bigint | null;
  feeLamports: number | null;
  slot: number | null;
  blockTime: number | null;
  quote: SwapQuote | null;
  costEstimate: CostEstimate | null;
  error: string | null;
}

export interface CostEstimate {
  amountLamports: number;
  priorityFeeLamports: number;
  networkFeeLamports: number;
  rentLamports: number;
  priceImpactPct: number;
  expectedOut: string;
  minOut: string;
}

const TERMINAL: OrderStatus[] = ["CONFIRMED", "FAILED", "EXPIRED", "REJECTED"];
/** Max extra lamports a buy may spend beyond amount + fees (ATA rents, pump user accumulator, rounding). */
const BUY_TOLERANCE_LAMPORTS = 3 * TOKEN_ACCOUNT_RENT_LAMPORTS + 2_000_000;

export class ExecutionEngine {
  private genesisChecked = false;
  private readonly tokenProgramCache = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly rpc: RpcManager,
    private readonly signer: Signer | null,
    private readonly providers: Record<string, SwapProvider>,
    private readonly settings: () => Settings,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { confirmTimeoutMs?: number; pollMs?: number; allowedTransferDestinations?: Map<string, number> } = {},
  ) {}

  get wallet(): string | null {
    return this.signer?.publicKey ?? null;
  }

  /** "Falsche Chain nicht verwenden": refuse to trade unless the RPC is Solana mainnet. */
  async assertMainnet(): Promise<void> {
    if (this.genesisChecked) return;
    const hash = await this.rpc.call<string>("getGenesisHash");
    if (hash !== MAINNET_GENESIS_HASH) throw new IntegrityError("NETWORK", `RPC is not Solana mainnet (genesis ${hash})`);
    this.genesisChecked = true;
  }

  async tokenProgramOf(mint: string): Promise<string> {
    const cached = this.tokenProgramCache.get(mint);
    if (cached) return cached;
    const info = await this.rpc.getAccountInfo(mint);
    if (!info) throw new PermanentError("MINT_NOT_FOUND", `mint ${mint} does not exist`);
    if (info.owner !== TOKEN_PROGRAM_ID && info.owner !== TOKEN_2022_PROGRAM_ID) {
      throw new IntegrityError("INVALID_MINT", `account ${mint} is not a token mint`);
    }
    this.tokenProgramCache.set(mint, info.owner);
    return info.owner;
  }

  private async tokenBalance(ata: string): Promise<bigint> {
    try {
      const r = await this.rpc.call<{ value: { amount: string } }>("getTokenAccountBalance", [ata, { commitment: "confirmed" }]);
      return BigInt(r.value.amount);
    } catch {
      return 0n; // account does not exist yet
    }
  }

  private async setOrder(id: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE orders SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  }

  async execute(req: ExecuteRequest): Promise<ExecutionResult> {
    if (!this.signer) throw new PermanentError("NO_WALLET", "bot wallet not configured");
    const wallet = this.signer.publicKey;
    const s = this.settings();
    const provider = this.providers[s.trading.executionProvider] ?? this.providers.jupiter;
    if (!provider) throw new PermanentError("NO_PROVIDER", "no execution provider configured");

    // idempotent order creation / resume
    const orderId = randomUUID();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO orders (id, idempotency_key, live_trade_id, kind, mint, status, provider, input_amount)
       VALUES ($1, $2, $3, $4, $5, 'CREATED', $6, $7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [orderId, req.idempotencyKey, req.liveTradeId, req.kind, req.mint ?? null, provider.name, req.amount.toString()],
    );
    if (ins.rows.length === 0) return this.resume(req.idempotencyKey);

    const result: ExecutionResult = {
      orderId,
      status: "CREATED",
      signature: null,
      solDeltaLamports: null,
      tokenDeltaRaw: null,
      feeLamports: null,
      slot: null,
      blockTime: null,
      quote: null,
      costEstimate: null,
      error: null,
    };
    try {
      await this.assertMainnet();
      const preLamports = (await this.rpc.callVerified<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }], (a, b) => Math.abs(a.value - b.value) < 1_000_000)).result.value;
      const maxPriorityLamports = Math.floor(s.trading.maxPriorityFeeSol * 1e9);
      let tx: VersionedTransaction;
      let expected: ExpectedEffect;
      let lastValidBlockHeight: number | null = null;
      let simAccounts: string[] = [wallet];
      const policy: GuardPolicy = {
        wallet,
        maxPriorityFeeLamports: maxPriorityLamports,
        maxWrapLamports: req.kind === "buy" ? Number(req.amount) + 10_000 : 0,
        allowedTransferDestinations: this.opts.allowedTransferDestinations ?? new Map(),
      };

      if (req.kind === "close") {
        // close an EMPTY token account after a full sell → refunds the rent to the wallet
        const mint = req.mint as string;
        const tokenProgram = await this.tokenProgramOf(mint);
        const ata = associatedTokenAddress(wallet, mint, tokenProgram);
        if ((await this.tokenBalance(ata)) !== 0n) throw new PermanentError("NOT_EMPTY", "token account still holds tokens");
        const bh = await this.rpc.getLatestBlockhash();
        lastValidBlockHeight = bh.lastValidBlockHeight;
        const owner = new PublicKey(wallet);
        const msg = new TransactionMessage({
          payerKey: owner,
          recentBlockhash: bh.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            new TransactionInstruction({
              programId: new PublicKey(tokenProgram),
              keys: [
                { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
              ],
              data: Buffer.from([9]),
            }),
          ],
        }).compileToV0Message();
        tx = new VersionedTransaction(msg);
        expected = { kind: "sell", preLamports, minSolIn: 0 };
      } else if (req.kind === "transfer") {
        if (!req.destination) throw new PermanentError("DESTINATION", "destination missing");
        const bh = await this.rpc.getLatestBlockhash();
        lastValidBlockHeight = bh.lastValidBlockHeight;
        const msg = new TransactionMessage({
          payerKey: new PublicKey(wallet),
          recentBlockhash: bh.blockhash,
          instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: new PublicKey(req.destination), lamports: Number(req.amount) })],
        }).compileToV0Message();
        tx = new VersionedTransaction(msg);
        policy.allowedTransferDestinations = new Map([[req.destination, Number(req.amount)]]);
        expected = { kind: "transfer", preLamports, maxSolOut: Number(req.amount) + LAMPORTS_PER_SIGNATURE };
      } else {
        const mint = req.mint as string;
        const tokenProgram = await this.tokenProgramOf(mint);
        const ata = associatedTokenAddress(wallet, mint, tokenProgram);
        simAccounts = [wallet, ata];
        const preToken = await this.tokenBalance(ata);
        const quote = await provider.quote({
          inputMint: req.kind === "buy" ? WSOL_MINT : mint,
          outputMint: req.kind === "buy" ? mint : WSOL_MINT,
          amount: req.amount,
          slippageBps: req.maxSlippageBps,
        });
        result.quote = quote;
        if (quote.priceImpactPct * 100 > req.maxSlippageBps) {
          throw new PermanentError("PRICE_IMPACT", `price impact ${quote.priceImpactPct.toFixed(2)}% exceeds slippage limit`);
        }
        const built = await provider.build(quote, wallet, maxPriorityLamports);
        lastValidBlockHeight = built.lastValidBlockHeight;
        tx = decodeTransaction(built.txBase64);
        const rent = preToken === 0n && req.kind === "buy" ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0;
        result.costEstimate = {
          amountLamports: req.kind === "buy" ? Number(req.amount) : 0,
          priorityFeeLamports: built.prioritizationFeeLamports ?? 0,
          networkFeeLamports: LAMPORTS_PER_SIGNATURE,
          rentLamports: rent,
          priceImpactPct: quote.priceImpactPct,
          expectedOut: quote.outAmount.toString(),
          minOut: quote.minOut.toString(),
        };
        expected =
          req.kind === "buy"
            ? {
                kind: "buy",
                preLamports,
                maxSolOut: Number(req.amount) + maxPriorityLamports + LAMPORTS_PER_SIGNATURE + BUY_TOLERANCE_LAMPORTS,
                preTokenRaw: preToken,
                ...(quote.minOut > 0n ? { minTokensIn: quote.minOut } : { minTokensIn: 1n }),
              }
            : {
                kind: "sell",
                preLamports,
                preTokenRaw: preToken,
                maxTokensOut: req.amount,
                minSolIn: Math.max(0, Number(quote.minOut) - maxPriorityLamports - LAMPORTS_PER_SIGNATURE),
              };
        await this.setOrder(orderId, { status: "QUOTED", quote: JSON.stringify(quote.raw ?? {}, bigintReplacer), cost_estimate: JSON.stringify(result.costEstimate), min_output_amount: quote.minOut.toString() });
      }

      // balance check before anything is signed
      const reserve = Math.floor(s.risk.minWalletReserveSol * 1e9);
      const needed = req.kind === "close" ? LAMPORTS_PER_SIGNATURE : req.kind === "buy" || req.kind === "transfer" ? Number(req.amount) + maxPriorityLamports + LAMPORTS_PER_SIGNATURE + (req.kind === "buy" ? BUY_TOLERANCE_LAMPORTS : 0) : maxPriorityLamports + LAMPORTS_PER_SIGNATURE;
      const mustKeep = req.kind === "sell" || req.kind === "close" ? 0 : reserve;
      if (preLamports - needed < mustKeep) {
        throw new PermanentError("INSUFFICIENT_SOL", `insufficient SOL: have ${preLamports}, need ${needed} + reserve ${mustKeep}`);
      }

      const report = inspectTransaction(tx, policy);
      await this.setOrder(orderId, { status: "VALIDATED", validation: JSON.stringify(report) });
      const sim = await this.rpc.simulateTransaction(Buffer.from(tx.serialize()).toString("base64"), simAccounts);
      const simReport = checkSimulation(sim, expected);
      await this.setOrder(orderId, { status: "SIMULATED", simulation: JSON.stringify({ ...simReport, tokenDelta: simReport.tokenDelta?.toString() ?? null, logs: (sim.logs ?? []).slice(-20) }) });

      const raw = this.signer.sign(tx, approve(report, simReport, this.clock.now()));
      const signature = Signer.signatureOf(tx);
      result.signature = signature;
      if (lastValidBlockHeight === null) lastValidBlockHeight = (await this.rpc.getBlockHeight()) + 150;
      // persist the signature BEFORE sending: after a crash the outcome can always be looked up
      await this.setOrder(orderId, { status: "SIGNED", signature, last_valid_block_height: lastValidBlockHeight });
      const b64 = Buffer.from(raw).toString("base64");
      await this.rpc.sendTransaction(b64);
      await this.setOrder(orderId, { status: "SENT", sent_at: new Date(this.clock.now()), attempts: 1 });
      return await this.confirm(orderId, signature, lastValidBlockHeight, b64, result, req.mint ?? null);
    } catch (err) {
      const status: OrderStatus = err instanceof PermanentError ? "REJECTED" : "FAILED";
      result.status = status;
      result.error = errorMessage(err);
      await this.setOrder(orderId, { status, error: result.error }).catch(() => undefined);
      metrics.executions.inc({ side: req.kind, outcome: status.toLowerCase() });
      this.log.warn({ orderId, kind: req.kind, mint: req.mint, err: result.error }, "execution not completed");
      return result;
    }
  }

  /** Wait for confirmation with bounded rebroadcast; EXPIRED once the blockhash is provably dead. */
  private async confirm(orderId: string, signature: string, lastValidBlockHeight: number, rawB64: string | null, result: ExecutionResult, mint: string | null): Promise<ExecutionResult> {
    const deadline = this.clock.now() + (this.opts.confirmTimeoutMs ?? 90_000);
    const pollMs = this.opts.pollMs ?? 1_500;
    let attempts = 1;
    let lastSend = this.clock.now();
    while (this.clock.now() < deadline) {
      const [status] = await this.rpc.getSignatureStatuses([signature]).catch(() => [null]);
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        if (status.err) {
          result.status = "FAILED";
          result.error = `on-chain error: ${JSON.stringify(status.err)}`;
          await this.setOrder(orderId, { status: "FAILED", error: result.error, slot: status.slot, confirmed_at: new Date(this.clock.now()) });
          metrics.executions.inc({ side: "tx", outcome: "failed_onchain" });
          // fees were still paid → parse actual effect
          await this.applyActual(orderId, signature, result, mint);
          return result;
        }
        result.status = "CONFIRMED";
        await this.applyActual(orderId, signature, result, mint);
        await this.setOrder(orderId, { status: "CONFIRMED", slot: result.slot, confirmed_at: new Date(this.clock.now()) });
        metrics.executions.inc({ side: "tx", outcome: "confirmed" });
        return result;
      }
      const height = await this.rpc.getBlockHeight().catch(() => 0);
      if (height > lastValidBlockHeight && !status) {
        result.status = "EXPIRED";
        result.error = "blockhash expired before confirmation";
        await this.setOrder(orderId, { status: "EXPIRED", error: result.error });
        metrics.executions.inc({ side: "tx", outcome: "expired" });
        return result;
      }
      if (rawB64 && this.clock.now() - lastSend > 3_000) {
        // rebroadcasting the SAME signed transaction is idempotent on chain
        await this.rpc.sendTransaction(rawB64, { skipPreflight: true }).catch(() => undefined);
        attempts++;
        lastSend = this.clock.now();
        await this.setOrder(orderId, { attempts });
      }
      await sleep(pollMs);
    }
    result.status = "SENT";
    result.error = "confirmation pending (timeout) — will be reconciled";
    return result;
  }

  /** Parse the real on-chain effect of our transaction (balances, fee, slot). */
  private async applyActual(orderId: string, signature: string, result: ExecutionResult, mint: string | null): Promise<void> {
    let tx: RpcTransaction | null = null;
    for (let i = 0; i < 5 && !tx; i++) {
      tx = await this.rpc.getTransaction(signature).catch(() => null);
      if (!tx) await sleep(800);
    }
    if (!tx?.meta) return;
    const wallet = this.signer?.publicKey;
    const keys = tx.transaction.message.accountKeys;
    const idx = keys.indexOf(wallet ?? "");
    result.solDeltaLamports = idx >= 0 ? (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0) : null;
    result.feeLamports = tx.meta.fee;
    result.slot = tx.slot;
    result.blockTime = tx.blockTime;
    if (mint && wallet) {
      const pre = tx.meta.preTokenBalances?.find((b) => b.mint === mint && b.owner === wallet);
      const post = tx.meta.postTokenBalances?.find((b) => b.mint === mint && b.owner === wallet);
      result.tokenDeltaRaw = BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
    }
    await this.setOrder(orderId, {
      result: JSON.stringify({
        solDeltaLamports: result.solDeltaLamports,
        tokenDeltaRaw: result.tokenDeltaRaw?.toString() ?? null,
        feeLamports: result.feeLamports,
        blockTime: result.blockTime,
      }),
      slot: tx.slot,
    });
  }

  /** Resume an order by idempotency key (restart / duplicate request). */
  async resume(idempotencyKey: string): Promise<ExecutionResult> {
    const o = await this.db.one<{
      id: string;
      status: OrderStatus;
      signature: string | null;
      last_valid_block_height: number | null;
      mint: string | null;
      result: { solDeltaLamports?: number; tokenDeltaRaw?: string; feeLamports?: number; blockTime?: number } | null;
      slot: number | null;
      error: string | null;
    }>("SELECT id, status, signature, last_valid_block_height, mint, result, slot, error FROM orders WHERE idempotency_key = $1", [idempotencyKey]);
    if (!o) throw new PermanentError("ORDER_NOT_FOUND", "order not found");
    const result: ExecutionResult = {
      orderId: o.id,
      status: o.status,
      signature: o.signature,
      solDeltaLamports: o.result?.solDeltaLamports ?? null,
      tokenDeltaRaw: o.result?.tokenDeltaRaw ? BigInt(o.result.tokenDeltaRaw) : null,
      feeLamports: o.result?.feeLamports ?? null,
      slot: o.slot,
      blockTime: o.result?.blockTime ?? null,
      quote: null,
      costEstimate: null,
      error: o.error,
    };
    if (TERMINAL.includes(o.status)) return result;
    if (o.signature && o.last_valid_block_height) {
      return this.confirm(o.id, o.signature, o.last_valid_block_height, null, result, o.mint);
    }
    // never signed → nothing was sent; mark failed so a new decision can be made
    await this.setOrder(o.id, { status: "FAILED", error: "interrupted before signing" });
    result.status = "FAILED";
    result.error = "interrupted before signing";
    return result;
  }
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
