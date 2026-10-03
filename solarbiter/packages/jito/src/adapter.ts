import type { TransactionInstruction } from "@solana/web3.js";
import { MAX_BUNDLE_TRANSACTIONS, chooseTip, tipInstruction, type BundleState, type JitoClient } from "./client.js";

export interface BundleResult {
  bundleId: string;
  state: BundleState | "Timeout";
  landedSlot: number | null;
  polls: number;
}

/**
 * Execution adapter for Jito bundles: create, submit, track, tip. A bundle either lands as a whole
 * or not at all — a transaction whose profit guard reverts is not included and costs nothing.
 */
export class JitoExecutionAdapter {
  constructor(
    private readonly client: JitoClient,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {}

  available(): { ok: boolean; reason: string | null } {
    return this.client.available();
  }

  async tipAccounts(): Promise<string[]> {
    return this.client.getTipAccounts();
  }

  tipLamports(expectedProfitLamports: bigint, o: { percentile: number; maxTipLamports: number; maxShareOfProfit: number }): bigint {
    return chooseTip(this.client.latestTipFloor(), { ...o, expectedProfitLamports });
  }

  async tipIx(from: string, lamports: bigint): Promise<TransactionInstruction> {
    return tipInstruction(from, await this.client.getTipAccounts(), Number(lamports));
  }

  createBundle(signedBase64: string[]): string[] {
    if (signedBase64.length === 0 || signedBase64.length > MAX_BUNDLE_TRANSACTIONS) throw new Error(`bundle must contain 1–${MAX_BUNDLE_TRANSACTIONS} transactions`);
    return [...signedBase64];
  }

  submit(bundle: string[]): Promise<string> {
    return this.client.sendBundle(bundle);
  }

  /** Poll the in-flight status until the bundle landed, failed, was dropped, or the timeout passed. */
  async waitForResult(bundleId: string, timeoutMs = 30_000, pollMs = 1_000): Promise<BundleResult> {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = now() + timeoutMs;
    let polls = 0;
    while (now() < deadline) {
      polls++;
      try {
        const [s] = await this.client.getInflightBundleStatuses([bundleId]);
        if (s && (s.status === "Landed" || s.status === "Failed")) return { bundleId, state: s.status, landedSlot: s.landedSlot, polls };
        // "Invalid" right after submission can mean "not yet indexed": keep polling until the deadline
      } catch {
        // transient status errors: keep polling; the signature status is checked independently
      }
      await sleep(pollMs);
    }
    return { bundleId, state: "Timeout", landedSlot: null, polls };
  }
}
