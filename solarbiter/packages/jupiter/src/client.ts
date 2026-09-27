import type { BuildSwapRequest, QuoteRequest, SwapInstructions, WireInstruction } from "@solarbiter/dex";
import { fetchJson, type Fetch } from "@solarbiter/dex";
import { QuoteBudget, newQuoteId } from "@solarbiter/quotes";
import { rawToUi, type DexId, type Quote, type RouteHop } from "@solarbiter/shared";
import { CircuitBreaker, IntegrityError, PermanentError, TransientError, metrics } from "@solarbiter/shared/node";
import type { Logger } from "pino";
import { JUPITER_PROGRAM_ID, SET_TOKEN_LEDGER_DISCRIMINATOR, decodeRouteArgs, minOutForSlippage } from "./instruction.js";
import { dexForLabel } from "./labels.js";

/** Quote response of GET /quote (only the fields SOLARBITER relies on are typed). */
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: {
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };
    percent: number | null;
    bps?: number | null;
  }[];
  contextSlot?: number;
  timeTaken?: number;
  [k: string]: unknown;
}

interface WireIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: WireIx | null;
  computeBudgetInstructions?: WireIx[];
  setupInstructions?: WireIx[];
  swapInstruction: WireIx;
  cleanupInstruction?: WireIx | null;
  otherInstructions?: WireIx[];
  addressLookupTableAddresses?: string[];
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  simulationError?: unknown;
}

export class QuoteBudgetExhaustedError extends TransientError {
  constructor(priority: string) {
    super("QUOTE_BUDGET_EXHAUSTED", `quote request budget exhausted (${priority})`);
  }
}

export class JupiterUnavailableError extends TransientError {
  constructor(reason: string) {
    super("ROUTE_UNAVAILABLE", `Jupiter unavailable: ${reason}`);
  }
}

export interface JupiterClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Requests per second allowed by the plan (keyless 0.5). */
  rps: number;
  log: Logger;
  fetchImpl?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  budget?: QuoteBudget;
}

/**
 * Client for the Jupiter Swap API (GET /quote, POST /swap-instructions).
 *
 *   - every request passes the shared request budget (the plan's rate limit) with a priority
 *   - quotes carry the receive timestamp and the context slot (freshness checks)
 *   - swap instructions are decoded and must encode exactly the quoted amounts and the requested
 *     slippage — otherwise the build is rejected (IntegrityError), never signed
 */
export class JupiterClient {
  readonly budget: QuoteBudget;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  private readonly baseUrl: string;
  requests = 0;
  errors = 0;
  lastError: string | null = null;
  lastOkAt: number | null = null;
  private latencies: number[] = [];

  constructor(private readonly opts: JupiterClientOptions) {
    this.now = opts.now ?? Date.now;
    this.budget = opts.budget ?? new QuoteBudget(opts.rps, this.now);
    this.breaker = new CircuitBreaker(5, 30_000, this.now);
    // Keyed plans are served from api.jup.ag, keyless from lite-api.jup.ag.
    let base = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiKey && base.includes("lite-api.jup.ag")) base = base.replace("lite-api.jup.ag", "api.jup.ag");
    this.baseUrl = base;
  }

  available(): { ok: boolean; reason: string | null } {
    if (this.breaker.isOpen) return { ok: false, reason: `circuit open after ${this.breaker.consecutiveFailures} failures: ${this.lastError ?? ""}` };
    return { ok: true, reason: null };
  }

  stats(): { requests: number; errors: number; lastError: string | null; lastOkAt: number | null; avgLatencyMs: number | null; used1m: number; limit1m: number } {
    const avg = this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : null;
    return { requests: this.requests, errors: this.errors, lastError: this.lastError, lastOkAt: this.lastOkAt, avgLatencyMs: avg, ...this.budget.usage() };
  }

  private headers(): Record<string, string> {
    return this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {};
  }

  private async call<T>(priority: QuoteRequest["priority"], maxWaitMs: number, fn: () => Promise<T>): Promise<{ value: T; latencyMs: number; receivedAt: number }> {
    const avail = this.available();
    if (!avail.ok) throw new JupiterUnavailableError(avail.reason ?? "unavailable");
    if (!(await this.budget.take(1, priority, maxWaitMs))) throw new QuoteBudgetExhaustedError(priority);
    const started = this.now();
    this.requests++;
    try {
      const value = await fn();
      const receivedAt = this.now();
      const latencyMs = receivedAt - started;
      this.breaker.recordSuccess();
      this.lastOkAt = receivedAt;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 200) this.latencies.shift();
      return { value, latencyMs, receivedAt };
    } catch (err) {
      this.errors++;
      this.lastError = (err as Error).message;
      // A 4xx for one pair (e.g. no route) is not an outage.
      if (!(err instanceof PermanentError)) this.breaker.recordFailure();
      throw err;
    }
  }

  /**
   * Firm quote. `dexes` restricts the route to these venue labels (null = any venue).
   * `source` is the adapter the quote is attributed to.
   */
  async quote(req: QuoteRequest, dexes: string[] | null, source: DexId): Promise<Quote> {
    if (req.amount <= 0n) throw new PermanentError("INVALID_AMOUNT", "quote amount must be positive");
    const q = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      slippageBps: String(req.slippageBps),
      swapMode: "ExactIn",
      onlyDirectRoutes: String(req.onlyDirectRoutes),
      instructionVersion: "V1",
    });
    if (dexes && dexes.length) q.set("dexes", dexes.join(","));
    if (req.maxAccounts) q.set("maxAccounts", String(req.maxAccounts));
    if (req.forJitoBundle) q.set("forJitoBundle", "true");
    const url = `${this.baseUrl}/quote?${q.toString()}`;
    const { value, latencyMs, receivedAt } = await this.call(req.priority, req.maxWaitMs ?? 0, () =>
      fetchJson<JupiterQuoteResponse>(url, { headers: this.headers(), timeoutMs: this.opts.timeoutMs ?? 4_000, fetchImpl: this.opts.fetchImpl }),
    );
    metrics.quoteLatency.observe({ source }, latencyMs);
    return mapQuote(value, req, source, receivedAt, latencyMs, dexes);
  }

  /**
   * Instructions for exactly this quote. `slippageBps` overrides the tolerance the swap instruction
   * enforces (used to encode "revert unless profitable" into the closing leg).
   */
  async swapInstructions(req: BuildSwapRequest): Promise<SwapInstructions> {
    const raw = req.quote.raw as JupiterQuoteResponse | undefined;
    if (!raw || typeof raw !== "object" || !raw.routePlan) throw new PermanentError("NOT_A_JUPITER_QUOTE", "quote has no Jupiter payload");
    const slippageBps = req.slippageBps ?? req.quote.slippageBps;
    const minOut = minOutForSlippage(req.quote.outputAmount, slippageBps);
    const body = {
      quoteResponse: { ...raw, slippageBps, otherAmountThreshold: minOut.toString() },
      userPublicKey: req.userPublicKey,
      wrapAndUnwrapSol: req.wrapAndUnwrapSol,
      dynamicComputeUnitLimit: false,
      dynamicSlippage: false,
      ...(req.useTokenLedger ? { useTokenLedger: true } : {}),
    };
    const { value } = await this.call("final", req.maxWaitMs ?? 3_000, () =>
      fetchJson<JupiterSwapInstructionsResponse>(`${this.baseUrl}/swap-instructions`, {
        method: "POST",
        body,
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs ?? 6_000,
        fetchImpl: this.opts.fetchImpl,
      }),
    );
    return verifySwapInstructions(value, req.quote, slippageBps, req.useTokenLedger === true);
  }
}

function toWire(ix: WireIx): WireInstruction {
  return { programId: ix.programId, accounts: ix.accounts.map((a) => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable })), data: ix.data };
}

/** Map and sanity-check a /quote response. */
export function mapQuote(r: JupiterQuoteResponse, req: QuoteRequest, source: DexId, receivedAt: number, latencyMs: number, dexes: string[] | null): Quote {
  if (r.inputMint !== req.inputMint || r.outputMint !== req.outputMint) throw new IntegrityError("QUOTE_MISMATCH", "quote mints differ from the request");
  if (r.swapMode !== "ExactIn") throw new IntegrityError("QUOTE_MISMATCH", `unexpected swapMode ${r.swapMode}`);
  const inAmount = BigInt(r.inAmount);
  const outAmount = BigInt(r.outAmount);
  if (inAmount !== req.amount) throw new IntegrityError("QUOTE_MISMATCH", "quoted input differs from the requested amount");
  if (!Array.isArray(r.routePlan) || r.routePlan.length === 0) throw new PermanentError("NO_ROUTE", "empty route plan");
  const route: RouteHop[] = r.routePlan.map((s) => ({
    dex: dexForLabel(s.swapInfo.label),
    label: s.swapInfo.label,
    pool: s.swapInfo.ammKey,
    inputMint: s.swapInfo.inputMint,
    outputMint: s.swapInfo.outputMint,
    inAmount: BigInt(s.swapInfo.inAmount),
    outAmount: BigInt(s.swapInfo.outAmount),
  }));
  if (dexes) {
    const outside = route.filter((h) => !dexes.includes(h.label));
    if (outside.length) throw new IntegrityError("QUOTE_MISMATCH", `route uses venues outside the filter: ${outside.map((h) => h.label).join(", ")}`);
  }
  const minOut = minOutForSlippage(outAmount, r.slippageBps);
  const threshold = BigInt(r.otherAmountThreshold);
  const priceImpact = Number(r.priceImpactPct);
  return {
    id: newQuoteId(receivedAt),
    kind: "firm",
    timestamp: receivedAt,
    slot: typeof r.contextSlot === "number" ? r.contextSlot : null,
    source,
    inputMint: r.inputMint,
    outputMint: r.outputMint,
    inputAmount: inAmount,
    outputAmount: outAmount,
    minOutputAmount: threshold < minOut ? threshold : minOut,
    slippageBps: r.slippageBps,
    price: rawToUi(outAmount, req.outputDecimals) / rawToUi(inAmount, req.inputDecimals),
    // Documented as a decimal fraction ("0.0001" = 0.01 %), measured against Jupiter's reference price.
    priceImpact: Number.isFinite(priceImpact) ? Math.max(0, priceImpact) : 0,
    feeRates: [],
    route,
    latencyMs,
    raw: r,
  };
}

/**
 * The instructions must be the Jupiter program, and the route arguments must encode exactly the quoted
 * input, the quoted output and the requested slippage. Anything else is refused.
 */
export function verifySwapInstructions(r: JupiterSwapInstructionsResponse, quote: Quote, slippageBps: number, tokenLedger = false): SwapInstructions {
  if (!r.swapInstruction) throw new IntegrityError("SWAP_BUILD_INVALID", "no swap instruction returned");
  if (r.simulationError) throw new PermanentError("SWAP_SIMULATION_ERROR", `swap-instructions reported a simulation error: ${JSON.stringify(r.simulationError).slice(0, 200)}`);
  if (r.swapInstruction.programId !== JUPITER_PROGRAM_ID) throw new IntegrityError("SWAP_BUILD_INVALID", `unexpected swap program ${r.swapInstruction.programId}`);
  const args = decodeRouteArgs(r.swapInstruction.data);
  if (!args) throw new IntegrityError("SWAP_BUILD_INVALID", "unknown swap instruction layout (cannot verify minimum output)");
  if (args.tokenLedger !== tokenLedger) throw new IntegrityError("SWAP_BUILD_INVALID", `expected a ${tokenLedger ? "token-ledger" : "fixed-input"} route, got ${args.instruction}`);
  let ledgerIx: WireInstruction | null = null;
  if (tokenLedger) {
    const l = r.tokenLedgerInstruction;
    if (!l || l.programId !== JUPITER_PROGRAM_ID || Buffer.from(l.data, "base64").subarray(0, 8).toString("hex") !== SET_TOKEN_LEDGER_DISCRIMINATOR) {
      throw new IntegrityError("SWAP_BUILD_INVALID", "token-ledger route without a valid set_token_ledger instruction");
    }
    ledgerIx = toWire(l);
  } else if (args.inAmount !== quote.inputAmount) {
    throw new IntegrityError("SWAP_BUILD_INVALID", `instruction input ${args.inAmount} ≠ quoted ${quote.inputAmount}`);
  }
  if (args.quotedOutAmount !== quote.outputAmount) throw new IntegrityError("SWAP_BUILD_INVALID", `instruction quoted output ${args.quotedOutAmount} ≠ quote ${quote.outputAmount}`);
  if (args.slippageBps !== slippageBps) throw new IntegrityError("SWAP_BUILD_INVALID", `instruction slippage ${args.slippageBps} ≠ requested ${slippageBps}`);
  if (args.platformFeeBps !== 0) throw new IntegrityError("SWAP_BUILD_INVALID", `unexpected platform fee ${args.platformFeeBps} bps`);
  return {
    tokenLedger: ledgerIx,
    computeBudget: (r.computeBudgetInstructions ?? []).map(toWire),
    setup: (r.setupInstructions ?? []).map(toWire),
    swap: toWire(r.swapInstruction),
    cleanup: r.cleanupInstruction ? toWire(r.cleanupInstruction) : null,
    other: (r.otherInstructions ?? []).map(toWire),
    lookupTables: r.addressLookupTableAddresses ?? [],
    lookupTableAddresses: r.addressesByLookupTableAddress ?? {},
    minOutputAmount: minOutForSlippage(args.quotedOutAmount, args.slippageBps),
  };
}
