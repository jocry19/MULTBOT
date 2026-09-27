import { PermanentError, TransientError } from "../../core/errors.js";
import { WSOL_MINT } from "../pumpfun/constants.js";

/**
 * Swap providers build UNSIGNED transactions; signing always happens locally after the
 * TransactionGuard and the simulation approved the exact transaction.
 */

export interface SwapQuote {
  provider: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum output after slippage (raw units). */
  minOut: bigint;
  priceImpactPct: number;
  route: string[];
  raw: unknown;
}

export interface BuiltSwap {
  txBase64: string;
  lastValidBlockHeight: number | null;
  prioritizationFeeLamports: number | null;
}

export interface SwapProvider {
  readonly name: string;
  quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<SwapQuote>;
  build(q: SwapQuote, wallet: string, maxPriorityFeeLamports: number): Promise<BuiltSwap>;
}

async function httpJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) throw new TransientError("PROVIDER_HTTP", `provider HTTP ${res.status}`);
  if (!res.ok) throw new PermanentError("PROVIDER_HTTP", `provider HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PermanentError("PROVIDER_RESPONSE", "provider returned invalid JSON");
  }
}

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan?: { swapInfo: { label?: string } }[];
  inputMint: string;
  outputMint: string;
}

export class JupiterProvider implements SwapProvider {
  readonly name = "jupiter";

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) };
  }

  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<SwapQuote> {
    const url = `${this.apiUrl}/quote?inputMint=${p.inputMint}&outputMint=${p.outputMint}&amount=${p.amount}&slippageBps=${p.slippageBps}&restrictIntermediateTokens=true`;
    const q = await httpJson<JupiterQuote & { error?: string }>(this.fetchImpl, url, { headers: this.headers() });
    if (q.error || !q.outAmount) throw new PermanentError("NO_ROUTE", q.error ?? "no route");
    if (q.inputMint !== p.inputMint || q.outputMint !== p.outputMint) throw new PermanentError("QUOTE_MISMATCH", "quote mints do not match the request");
    return {
      provider: this.name,
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inAmount: BigInt(q.inAmount),
      outAmount: BigInt(q.outAmount),
      minOut: BigInt(q.otherAmountThreshold),
      priceImpactPct: Number(q.priceImpactPct) * 100,
      route: (q.routePlan ?? []).map((r) => r.swapInfo.label ?? "?"),
      raw: q,
    };
  }

  async build(q: SwapQuote, wallet: string, maxPriorityFeeLamports: number): Promise<BuiltSwap> {
    const res = await httpJson<{ swapTransaction?: string; lastValidBlockHeight?: number; prioritizationFeeLamports?: number; error?: string }>(
      this.fetchImpl,
      `${this.apiUrl}/swap`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          quoteResponse: q.raw,
          userPublicKey: wallet,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityFeeLamports, priorityLevel: "high" } },
        }),
      },
      15_000,
    );
    if (!res.swapTransaction) throw new PermanentError("BUILD_FAILED", res.error ?? "swap transaction missing");
    return {
      txBase64: res.swapTransaction,
      lastValidBlockHeight: res.lastValidBlockHeight ?? null,
      prioritizationFeeLamports: res.prioritizationFeeLamports ?? null,
    };
  }
}

/**
 * PumpPortal "trade-local" API (returns an unsigned transaction for pump.fun / PumpSwap).
 * It has no quote endpoint: minimum output is enforced by the program's slippage parameter and
 * by our own simulation bounds. Any fee transfer it adds must be allow-listed explicitly.
 */
export class PumpPortalProvider implements SwapProvider {
  readonly name = "pumpportal";

  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<SwapQuote> {
    // no remote quote: callers pass their own curve estimate via `raw.estimatedOut`
    return {
      provider: this.name,
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      inAmount: p.amount,
      outAmount: 0n,
      minOut: 0n,
      priceImpactPct: 0,
      route: ["pumpportal"],
      raw: { slippageBps: p.slippageBps },
    };
  }

  async build(q: SwapQuote, wallet: string, maxPriorityFeeLamports: number): Promise<BuiltSwap> {
    const isBuy = q.inputMint === WSOL_MINT;
    const mint = isBuy ? q.outputMint : q.inputMint;
    const slippageBps = (q.raw as { slippageBps: number }).slippageBps;
    const res = await this.fetchImpl(`${this.apiUrl}/trade-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: wallet,
        action: isBuy ? "buy" : "sell",
        mint,
        amount: isBuy ? Number(q.inAmount) / 1e9 : q.inAmount.toString(),
        denominatedInSol: isBuy ? "true" : "false",
        slippage: slippageBps / 100,
        priorityFee: maxPriorityFeeLamports / 1e9,
        pool: "auto",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new TransientError("PROVIDER_HTTP", `pumpportal HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { txBase64: buf.toString("base64"), lastValidBlockHeight: null, prioritizationFeeLamports: null };
  }
}
