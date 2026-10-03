import type { ComponentStatus } from "@solarbiter/shared";
import {
  BaseModule,
  CircuitBreaker,
  PermanentError,
  TokenBucket,
  TransientError,
  backoffDelay,
  errorMessage,
  metrics,
  redactUrl,
  sleep,
} from "@solarbiter/shared/node";
import type { Logger } from "pino";

export interface RpcEndpointConfig {
  name: string;
  kind: "helius" | "generic";
  httpUrl: string;
  wsUrl: string | null;
  rps: number;
}

/**
 * JSON-RPC client over several Solana endpoints (Helius first) with:
 *  - per-endpoint rate limiting (token bucket) and 429 back-off
 *  - circuit breakers and automatic failover
 *  - health checks: latency (EWMA), slot tracking, slot lag between endpoints
 *  - bounded retries (never endless loops) with error classification
 *  - optional cross-endpoint verification for critical reads
 */

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** JSON-RPC error codes that are worth retrying (possibly on another endpoint). */
const TRANSIENT_RPC_CODES = new Set([
  -32004, // block not available
  -32005, // node unhealthy / behind
  -32014, // block status not yet available
  -32016, // min context slot not reached
  -32603, // internal error
  429,
]);

export function isTransientRpcError(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  if (err instanceof TransientError) return true;
  if (err instanceof RpcError) return TRANSIENT_RPC_CODES.has(err.code);
  // network errors, aborts/timeouts
  return true;
}

interface EndpointState {
  config: RpcEndpointConfig;
  bucket: TokenBucket;
  breaker: CircuitBreaker;
  latencyMs: number | null;
  slot: number | null;
  slotAt: number | null;
  requests: number;
  errors: number;
  /** Rolling error-rate estimate (EWMA of 0/1 outcomes). */
  errorRate: number;
  lastError: string | null;
  healthy: boolean;
}

export interface RpcCallOptions {
  timeoutMs?: number;
  attempts?: number;
  /** Pin the call to a specific endpoint name (no failover). */
  endpoint?: string;
  /** Skip endpoints by name (used for cross-verification). */
  exclude?: string[];
  signal?: AbortSignal;
}

export interface EndpointHealth {
  name: string;
  kind: string;
  url: string;
  status: ComponentStatus;
  latencyMs: number | null;
  slot: number | null;
  slotLag: number | null;
  errorRate: number;
  requests: number;
  lastError: string | null;
}

export interface RpcManagerOptions {
  fetchImpl?: typeof fetch;
  healthIntervalMs?: number;
  requestTimeoutMs?: number;
  /** An endpoint more than this many slots behind the best one is considered degraded. */
  maxSlotLag?: number;
}

export class RpcManager extends BaseModule {
  private readonly endpoints: EndpointState[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxSlotLag: number;
  private idCounter = 0;
  private highestSlot = 0;

  constructor(configs: RpcEndpointConfig[], log: Logger, opts: RpcManagerOptions = {}) {
    super("rpc", log);
    if (configs.length === 0) throw new Error("at least one RPC endpoint is required");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.maxSlotLag = opts.maxSlotLag ?? 50;
    this.endpoints = configs.map((config) => ({
      config,
      bucket: new TokenBucket(config.rps, Math.max(2, config.rps)),
      breaker: new CircuitBreaker(5, 20_000),
      latencyMs: null,
      slot: null,
      slotAt: null,
      requests: 0,
      errors: 0,
      errorRate: 0,
      lastError: null,
      healthy: true,
    }));
    this.every("health", opts.healthIntervalMs ?? 10_000, () => this.checkHealth(), true);
  }

  get endpointNames(): string[] {
    return this.endpoints.map((e) => e.config.name);
  }

  get wsEndpoints(): { name: string; wsUrl: string }[] {
    return this.endpoints
      .filter((e) => e.config.wsUrl)
      .map((e) => ({ name: e.config.name, wsUrl: e.config.wsUrl as string }));
  }

  get primaryKind(): "helius" | "generic" {
    return this.endpoints[0]?.config.kind ?? "generic";
  }

  hasHelius(): boolean {
    return this.endpoints.some((e) => e.config.kind === "helius");
  }

  /** Best-known cluster slot across endpoints. */
  get currentSlot(): number {
    return this.highestSlot;
  }

  /** Candidate endpoints ordered by health score. */
  private ranked(exclude: Set<string>): EndpointState[] {
    const candidates = this.endpoints.filter((e) => !exclude.has(e.config.name));
    const open = candidates.filter((e) => !e.breaker.isOpen);
    const pool = open.length > 0 ? open : candidates; // all breakers open → still try (half-open probe)
    return [...pool].sort((a, b) => this.score(a) - this.score(b));
  }

  private score(e: EndpointState): number {
    const lag = e.slot !== null && this.highestSlot > 0 ? Math.max(0, this.highestSlot - e.slot) : 0;
    const lagPenalty = lag > this.maxSlotLag ? 5_000 : lag * 10;
    const latency = e.latencyMs ?? 500;
    const errors = e.errorRate * 3_000;
    const preference = e.config.kind === "helius" ? -50 : 0;
    return latency + lagPenalty + errors + preference;
  }

  async call<T>(method: string, params: unknown[] = [], opts: RpcCallOptions = {}): Promise<T> {
    const attempts = Math.max(1, opts.attempts ?? 3);
    const tried = new Set<string>(opts.exclude ?? []);
    let lastErr: unknown = new Error("no RPC endpoint available");

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let endpoint: EndpointState | undefined;
      if (opts.endpoint) {
        endpoint = this.endpoints.find((e) => e.config.name === opts.endpoint);
        if (!endpoint) throw new PermanentError("RPC_ENDPOINT", `unknown endpoint ${opts.endpoint}`);
      } else {
        const ranked = this.ranked(tried);
        endpoint = ranked[0] ?? this.ranked(new Set(opts.exclude ?? []))[0];
      }
      if (!endpoint) break;

      try {
        return await this.request<T>(endpoint, method, params, opts);
      } catch (err) {
        lastErr = err;
        if (!isTransientRpcError(err)) throw err;
        if (!opts.endpoint && this.endpoints.length > 1) tried.add(endpoint.config.name);
        if (attempt < attempts) await sleep(backoffDelay(attempt, 200, 3_000), opts.signal);
      }
    }
    throw lastErr;
  }

  private async request<T>(e: EndpointState, method: string, params: unknown[], opts: RpcCallOptions): Promise<T> {
    await e.bucket.take(1, 20_000, opts.signal);
    const id = ++this.idCounter;
    const started = performance.now();
    e.requests++;
    const endpointLabel = e.config.name;
    try {
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)])
        : AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
      const res = await this.fetchImpl(e.config.httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal,
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        e.bucket.penalize(Math.min(10_000, Math.max(500, retryAfter * 1000)));
        throw new TransientError("RPC_RATE_LIMIT", `rate limited by ${endpointLabel}`);
      }
      if (res.status >= 500) throw new TransientError("RPC_HTTP", `HTTP ${res.status} from ${endpointLabel}`);
      if (!res.ok) throw new PermanentError("RPC_HTTP", `HTTP ${res.status} from ${endpointLabel}`);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.data);
      this.recordOutcome(e, true, performance.now() - started);
      
      return body.result as T;
    } catch (err) {
      const transient = isTransientRpcError(err);
      // Deterministic RPC errors (bad params, simulation failure) say nothing about endpoint health.
      if (transient) this.recordOutcome(e, false, performance.now() - started, err);
      
      throw err;
    }
  }

  private recordOutcome(e: EndpointState, ok: boolean, latencyMs: number, err?: unknown): void {
    e.errorRate = e.errorRate * 0.9 + (ok ? 0 : 0.1);
    if (ok) {
      e.breaker.recordSuccess();
      e.latencyMs = e.latencyMs === null ? latencyMs : e.latencyMs * 0.8 + latencyMs * 0.2;
      metrics.rpcLatency.observe({ endpoint: e.config.name, method: "any" }, latencyMs);
    } else {
      e.errors++;
      e.breaker.recordFailure();
      e.lastError = errorMessage(err);
    }
  }

  /** Periodic health check: slot + latency per endpoint. */
  async checkHealth(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (e) => {
        try {
          const slot = await this.request<number>(e, "getSlot", [{ commitment: "processed" }], { timeoutMs: 5_000 });
          if (e.slot !== null && slot < e.slot - 100) {
            // Slot went backwards substantially: stale or misbehaving endpoint.
            e.lastError = `slot regressed from ${e.slot} to ${slot}`;
            e.healthy = false;
          } else {
            e.healthy = true;
          }
          e.slot = slot;
          e.slotAt = Date.now();
          if (slot > this.highestSlot) this.highestSlot = slot;
        } catch (err) {
          e.healthy = false;
          e.lastError = errorMessage(err);
        }
      }),
    );
  }

  endpointHealth(): EndpointHealth[] {
    return this.endpoints.map((e) => {
      const slotLag = e.slot !== null && this.highestSlot > 0 ? this.highestSlot - e.slot : null;
      let status: ComponentStatus = "UNKNOWN";
      if (e.slot !== null || e.requests > 0) {
        if (!e.healthy || e.breaker.isOpen) status = "DISCONNECTED";
        else if ((slotLag ?? 0) > this.maxSlotLag || e.errorRate > 0.3) status = "DEGRADED";
        else status = "CONNECTED";
      }
      return {
        name: e.config.name,
        kind: e.config.kind,
        url: redactUrl(e.config.httpUrl),
        status,
        latencyMs: e.latencyMs === null ? null : Math.round(e.latencyMs),
        slot: e.slot,
        slotLag,
        errorRate: Number(e.errorRate.toFixed(3)),
        requests: e.requests,
        lastError: e.lastError,
      };
    });
  }

  override componentStatus(): ComponentStatus {
    const h = this.endpointHealth();
    if (h.some((e) => e.status === "CONNECTED")) return "CONNECTED";
    if (h.some((e) => e.status === "DEGRADED")) return "DEGRADED";
    if (h.every((e) => e.status === "UNKNOWN")) return "UNKNOWN";
    return "DISCONNECTED";
  }

  override healthDetail(): string {
    return this.endpointHealth()
      .map((e) => `${e.name}:${e.status}${e.latencyMs !== null ? `(${e.latencyMs}ms)` : ""}`)
      .join(" ");
  }

  /**
   * Query the same method on two different endpoints and compare the results.
   * Returns `verified: false` when only one endpoint is available or results disagree.
   * Used for critical reads (balances before trading, confirmation of our own transactions).
   */
  async callVerified<T>(
    method: string,
    params: unknown[],
    equal: (a: T, b: T) => boolean,
    opts: RpcCallOptions = {},
  ): Promise<{ result: T; verified: boolean; mismatch?: { primary: T; secondary: T } }> {
    const ranked = this.ranked(new Set(opts.exclude ?? []));
    const primary = ranked[0];
    if (!primary) throw new TransientError("RPC_UNAVAILABLE", "no RPC endpoint available");
    const result = await this.call<T>(method, params, { ...opts, endpoint: primary.config.name });
    const secondary = ranked.find((e) => e !== primary);
    if (!secondary) return { result, verified: false };
    try {
      const other = await this.call<T>(method, params, { ...opts, endpoint: secondary.config.name, attempts: 1 });
      if (equal(result, other)) return { result, verified: true };
      this.log.warn({ method, primary: primary.config.name, secondary: secondary.config.name }, "RPC cross-check mismatch");
      return { result, verified: false, mismatch: { primary: result, secondary: other } };
    } catch {
      return { result, verified: false };
    }
  }

  // ------------------------------------------------------------------------------------------
  // Typed convenience wrappers
  // ------------------------------------------------------------------------------------------

  getSlot(commitment: Commitment = "confirmed"): Promise<number> {
    return this.call<number>("getSlot", [{ commitment }]);
  }

  async getBalance(address: string, commitment: Commitment = "confirmed"): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment }]);
    return r.value;
  }

  async getLatestBlockhash(commitment: Commitment = "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
      { commitment },
    ]);
    return r.value;
  }

  getBlockHeight(commitment: Commitment = "confirmed"): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }

  getSignaturesForAddress(
    address: string,
    opts: { limit?: number; before?: string; until?: string; commitment?: Commitment } = {},
  ): Promise<SignatureInfo[]> {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [
      address,
      { limit: opts.limit ?? 1000, before: opts.before, until: opts.until, commitment: opts.commitment ?? "confirmed" },
    ]);
  }

  getTransaction(signature: string, commitment: Commitment = "confirmed"): Promise<RpcTransaction | null> {
    return this.call<RpcTransaction | null>("getTransaction", [
      signature,
      { encoding: "json", commitment, maxSupportedTransactionVersion: 1 },
    ]);
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [
      signatures,
      { searchTransactionHistory: true },
    ]);
    return r.value;
  }

  async getAccountInfo(address: string, commitment: Commitment = "confirmed"): Promise<AccountInfo | null> {
    const r = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [
      address,
      { encoding: "base64", commitment },
    ]);
    return r.value;
  }

  async getMultipleAccounts(addresses: string[], commitment: Commitment = "confirmed"): Promise<(AccountInfo | null)[]> {
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await this.call<{ value: (AccountInfo | null)[] }>("getMultipleAccounts", [
        addresses.slice(i, i + 100),
        { encoding: "base64", commitment },
      ]);
      out.push(...r.value);
    }
    return out;
  }

  /** Like getMultipleAccounts, plus the slot the (first batch of the) response was read at. */
  async getMultipleAccountsWithSlot(addresses: string[], commitment: Commitment = "confirmed"): Promise<{ slot: number; accounts: (AccountInfo | null)[] }> {
    const accounts: (AccountInfo | null)[] = [];
    let slot = 0;
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await this.call<{ context: { slot: number }; value: (AccountInfo | null)[] }>("getMultipleAccounts", [
        addresses.slice(i, i + 100),
        { encoding: "base64", commitment },
      ]);
      slot = slot === 0 ? r.context.slot : Math.min(slot, r.context.slot);
      accounts.push(...r.value);
    }
    return { slot, accounts };
  }

  /** Recent prioritization fees (micro-lamports per CU) paid by transactions writing these accounts. */
  getRecentPrioritizationFees(accounts: string[] = []): Promise<{ slot: number; prioritizationFee: number }[]> {
    return this.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", accounts.length ? [accounts.slice(0, 128)] : []);
  }

  async getTokenAccountsByOwner(owner: string, programId: string): Promise<ParsedTokenAccount[]> {
    const r = await this.call<{ value: ParsedTokenAccount[] }>("getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    return r.value;
  }

  async getTokenLargestAccounts(mint: string): Promise<{ address: string; amount: string; uiAmount: number | null }[]> {
    const r = await this.call<{ value: { address: string; amount: string; uiAmount: number | null }[] }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }],
    );
    return r.value;
  }

  async getTokenSupply(mint: string): Promise<{ amount: string; decimals: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number } }>("getTokenSupply", [mint]);
    return r.value;
  }

  async simulateTransaction(
    base64Tx: string,
    accounts: string[] = [],
    opts: { replaceRecentBlockhash?: boolean } = {},
  ): Promise<SimulationResult> {
    const r = await this.call<{ context: { slot: number }; value: SimulationResult }>(
      "simulateTransaction",
      [
        base64Tx,
        {
          encoding: "base64",
          commitment: "processed",
          sigVerify: false,
          replaceRecentBlockhash: opts.replaceRecentBlockhash ?? false,
          ...(accounts.length ? { accounts: { encoding: "jsonParsed", addresses: accounts } } : {}),
        },
      ],
      { attempts: 2 },
    );
    return { ...r.value, contextSlot: r.context.slot };
  }

  /** Sends a signed transaction. Preflight is enabled: a transaction failing simulation is rejected by the node. */
  sendTransaction(base64Tx: string, opts: { skipPreflight?: boolean; endpoint?: string } = {}): Promise<string> {
    return this.call<string>(
      "sendTransaction",
      [base64Tx, { encoding: "base64", skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "processed", maxRetries: 0 }],
      { attempts: 1, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) },
    );
  }
}

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus?: Commitment;
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: Commitment | null;
}

export interface AccountInfo {
  lamports: number;
  owner: string;
  data: [string, string];
  executable: boolean;
  rentEpoch: number;
}

export interface ParsedTokenAccount {
  pubkey: string;
  account: {
    lamports: number;
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
        };
      };
    };
  };
}

export interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages: string[] | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null;
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    computeUnitsConsumed?: number;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      recentBlockhash: string;
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
}

export interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface SimulationResult {
  err: unknown;
  logs: string[] | null;
  accounts?: ({ lamports: number; owner: string; data: unknown } | null)[] | null;
  unitsConsumed?: number;
  returnData?: unknown;
  contextSlot?: number;
}
