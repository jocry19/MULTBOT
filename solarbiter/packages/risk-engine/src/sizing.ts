import type { Settings, TradeMode } from "@solarbiter/shared";

/**
 * Capital scaling (not linear): capital → suggested maximum trade size.
 * This is a CEILING the system may suggest; it never raises the user's own limit by itself.
 */
export const CAPITAL_SCALING: readonly [number, number][] = [
  [15, 5],
  [20, 6],
  [30, 8],
  [50, 12],
  [100, 20],
];

export function scalingCapEur(capitalEur: number): number {
  if (!(capitalEur > 0)) return 0;
  const first = CAPITAL_SCALING[0] as [number, number];
  if (capitalEur < first[0]) return (capitalEur * first[1]) / first[0];
  let cap = first[1];
  for (const [threshold, size] of CAPITAL_SCALING) if (capitalEur >= threshold) cap = size;
  return cap;
}

export interface SizingContext {
  mode: TradeMode;
  settings: Settings;
  capitalEur: number;
  /** Trade size (EUR) that moves the pool price ~1 % — never trade more than a fraction of it. */
  liquidityDepthEur: number | null;
  drawdownEur: number;
  /** Learned net expectancy per trade (EUR); null = not enough data yet. */
  expectancyEur: number | null;
  /** Consecutive losing trades in this mode. */
  lossStreak: number;
  lastTradeSizeEur: number | null;
  lastTradeLost: boolean;
}

export interface SizeCap {
  capEur: number;
  binding: string;
  components: Record<string, number>;
}

/** Share of the 1 %-depth a single trade may use. */
export const LIQUIDITY_SHARE = 0.25;

/**
 * The effective maximum trade size: the minimum of every limit. It can only be lowered by losses,
 * drawdown, bad expectancy or thin liquidity — never raised above the user's own limits.
 * No martingale: after a loss the size never grows; after a losing streak it halves per loss.
 */
export function effectiveMaxTradeEur(ctx: SizingContext): SizeCap {
  const s = ctx.settings;
  const minSize = Math.min(...s.strategy.tradeSizesEur);
  const components: Record<string, number> = {
    userMax: s.capital.maxTradeEur,
    capitalScaling: scalingCapEur(ctx.capitalEur),
    reserve: Math.max(0, ctx.capitalEur - s.capital.reserveCapitalEur),
  };
  if (ctx.mode === "live") components.liveLevel = s.risk.liveLevelMaxTradeEur[s.risk.liveLevel - 1] as number;
  if (ctx.liquidityDepthEur !== null) components.liquidity = ctx.liquidityDepthEur * LIQUIDITY_SHARE;
  const ddLimit = s.risk.dailyLossLimitEur;
  if (ddLimit > 0 && ctx.drawdownEur > ddLimit / 2) components.drawdown = s.capital.maxTradeEur / 2;
  if (ctx.expectancyEur !== null && ctx.expectancyEur <= 0) components.expectancy = minSize;
  if (ctx.lastTradeLost && ctx.lastTradeSizeEur !== null) components.noMartingale = ctx.lastTradeSizeEur;
  if (ctx.lossStreak >= 2) components.lossStreak = s.capital.maxTradeEur * 0.5 ** (ctx.lossStreak - 1);
  let binding = "userMax";
  let capEur = Number.POSITIVE_INFINITY;
  for (const [k, v] of Object.entries(components)) {
    if (v < capEur) {
      capEur = v;
      binding = k;
    }
  }
  return { capEur: Math.max(0, capEur), binding, components };
}

/**
 * When capital growth would justify a larger size than the user allows, the system only SUGGESTS
 * it. Raising the limit is a manual action.
 */
export function scalingSuggestion(capitalEur: number, settings: Settings): { suggestedMaxTradeEur: number; requiresUserConfirmation: true } | null {
  const suggested = scalingCapEur(capitalEur);
  return suggested > settings.capital.maxTradeEur ? { suggestedMaxTradeEur: suggested, requiresUserConfirmation: true } : null;
}
