import type { ExitReason, StrategySpec } from "@multbot/shared";
import type { FeatureVector } from "../features/types.js";
import { invalidated } from "../strategy/evaluate.js";

/**
 * Exit rules shared by backtests, paper and live trading, so validated behaviour and traded
 * behaviour are identical.
 *
 * Price rules: take profit, stop loss, trailing stop, max hold (time decay).
 * Feature rules (evaluated at decision points of the held token):
 *   - signal invalidation (spec.exit.invalidation)
 *   - adaptive exits (only if the strategy opted in via params.adaptiveExits and was validated
 *     with them): liquidity deterioration, sell pressure / whale or creator exit, momentum reversal
 */

export interface HeldPosition {
  entryPrice: number;
  entrySpot: number;
  entryLiquidity: number;
  openedAt: number;
  peak: number;
  trough: number;
}

export function updateExtremes(p: HeldPosition, price: number): void {
  if (price > p.peak) p.peak = price;
  if (price < p.trough) p.trough = price;
}

export function priceExit(spec: StrategySpec, p: HeldPosition, price: number, now: number): ExitReason | null {
  const tp = spec.exit.takeProfitPct;
  const sl = spec.exit.stopLossPct;
  const trail = spec.exit.trailingStopPct;
  if (tp !== undefined && price >= p.entryPrice * (1 + tp)) return "TAKE_PROFIT";
  if (sl !== undefined && price <= p.entryPrice * (1 - sl)) return "STOP_LOSS";
  if (trail !== undefined && p.peak > p.entryPrice && price <= p.peak * (1 - trail)) return "TRAILING_STOP";
  if (now - p.openedAt >= spec.exit.maxHoldSec * 1000) return "MAX_HOLD";
  return null;
}

export function adaptiveExitsEnabled(spec: StrategySpec): boolean {
  return spec.params.adaptiveExits === true;
}

export function featureExit(spec: StrategySpec, p: HeldPosition, f: FeatureVector): ExitReason | null {
  if (invalidated(spec, f)) return "SIGNAL_INVALIDATED";
  if (!adaptiveExitsEnabled(spec)) return null;
  const liq = f.liquidity_sol;
  if (liq !== undefined && p.entryLiquidity > 0 && liq < p.entryLiquidity * 0.5) return "LIQUIDITY_DETERIORATION";
  if ((f.liq_withdraw_share_15m ?? 0) >= 0.3) return "LIQUIDITY_DETERIORATION";
  const recent = (type: string, sec: number) => {
    const age = f[`ev_${type}_age`];
    return age !== undefined && age <= sec;
  };
  if (recent("creator_sell", 30) || recent("whale_exit", 30) || recent("smart_money_exit", 30)) return "SELL_PRESSURE";
  if (recent("seller_surge", 30) && (f.net_flow_60s ?? 0) < 0) return "SELL_PRESSURE";
  if (recent("price_crash", 30)) return "MOMENTUM_REVERSAL";
  return null;
}
