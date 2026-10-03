import { BASE_FEE_LAMPORTS_PER_SIGNATURE, eurToLamports, maxSlippageForMinOut, minOutForSlippage, type Opportunity } from "@solarbiter/shared";

export interface ClosingGuard {
  /** SOL the closing leg must return at least — otherwise the whole transaction reverts. */
  requiredOutLamports: bigint;
  /** Slippage tolerance of the closing leg that encodes exactly this minimum. */
  slippageBps: number;
  /** Minimum the swap instruction will enforce (≥ requiredOut). */
  enforcedMinOutLamports: bigint;
}

/**
 * The profit guard of an atomic route: the closing leg's minimum output covers the input, every
 * network cost, the Jito tip and the minimum net profit. If the market moves against the trade
 * before it lands, the transaction reverts instead of losing money. Null = the current quote does
 * not even reach the requirement (no trade).
 */
export function closingGuard(o: Opportunity, minNetProfitEur: number): ClosingGuard | null {
  const last = o.legs[o.legs.length - 1];
  if (!last || o.inputAmount <= 0n) return null;
  const costs = BigInt(BASE_FEE_LAMPORTS_PER_SIGNATURE) + o.priorityFee + o.jitoTip;
  const minProfit = minNetProfitEur > 0 ? eurToLamports(minNetProfitEur, o.solEur) : 0n;
  const requiredOut = o.inputAmount + costs + minProfit;
  const slippageBps = maxSlippageForMinOut(last.outputAmount, requiredOut);
  if (slippageBps === null) return null;
  return { requiredOutLamports: requiredOut, slippageBps, enforcedMinOutLamports: minOutForSlippage(last.outputAmount, slippageBps) };
}
