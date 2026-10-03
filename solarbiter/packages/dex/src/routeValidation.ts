import type { Quote } from "@solarbiter/shared";
import type { RouteValidation } from "./types.js";

/**
 * Generic route checks shared by all adapters:
 *   - route exists, hop count within limit, chain of mints is continuous
 *   - starts with the expected input mint and ends with the expected output mint
 *   - only venues in `allowedLabels` (null = any venue, used for the aggregated Jupiter route)
 *   - amounts positive and consistent with the quote totals
 */
export function validateRouteGeneric(
  quote: Quote,
  expect: { inputMint: string; outputMint: string; maxHops: number },
  allowedLabels: string[] | null,
): RouteValidation {
  const reasons: string[] = [];
  const r = quote.route;
  if (r.length === 0) reasons.push("empty route");
  if (r.length > expect.maxHops) reasons.push(`route has ${r.length} hops (max ${expect.maxHops})`);
  if (quote.inputMint !== expect.inputMint) reasons.push("unexpected input mint");
  if (quote.outputMint !== expect.outputMint) reasons.push("unexpected output mint");
  if (r.length > 0) {
    if (r[0]?.inputMint !== expect.inputMint) reasons.push("route does not start with the input mint");
    if (r[r.length - 1]?.outputMint !== expect.outputMint) reasons.push("route does not end with the output mint");
    for (let i = 1; i < r.length; i++) {
      if (r[i]?.inputMint !== r[i - 1]?.outputMint) reasons.push(`route hop ${i} is not connected`);
    }
    if (allowedLabels) {
      const bad = r.filter((h) => !allowedLabels.includes(h.label)).map((h) => h.label);
      if (bad.length) reasons.push(`venue(s) not allowed for this adapter: ${[...new Set(bad)].join(", ")}`);
    }
  }
  if (quote.inputAmount <= 0n || quote.outputAmount <= 0n) reasons.push("non-positive amounts");
  if (quote.minOutputAmount > quote.outputAmount) reasons.push("minimum output above quoted output");
  return { ok: reasons.length === 0, reasons };
}
