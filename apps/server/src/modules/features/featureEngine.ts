import type { MarketState } from "../market/marketState.js";
import type { TokenState } from "../market/tokenState.js";
import type { WindowStats } from "../market/tape.js";
import type { CreatorIntel, FeatureVector, WalletIntel } from "./types.js";

/**
 * Base feature computation. Pure and causal: uses only the token/market state and only trades
 * with ts <= now. The same function runs in live mode and in historical replay.
 *
 * Naming: <quantity>_<window>, windows in seconds (10s, 30s, 60s, 5m=300s, 15m=900s).
 */

const EPS = 1e-9;
const SEC = 1000;

function ratio(a: number, b: number): number {
  return a / (Math.abs(b) + EPS);
}

function logRet(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return Math.log(to / from);
}

export interface FeatureContext {
  wallets: WalletIntel;
  creators: CreatorIntel;
  /** Seconds since the last detected event of each type for this token (from EventEngine). */
  eventAges?: Record<string, number>;
  /** Market-wide regime features (already computed for this tick). */
  market?: FeatureVector;
}

export const EVENT_AGE_CAP_SEC = 3600;

/** Features that need 5 minutes of observation. */
const WINDOW_5M_FEATURES = ["ret_5m", "volume_5m", "net_flow_5m", "buy_ratio_5m", "trades_5m", "volume_accel_5m", "volume_to_mcap_5m", "volume_to_liq_5m", "unique_buyers_5m", "runup_from_low_5m", "range_5m", "volatility_5m", "vol_expansion", "holder_growth_5m", "momentum_score", "liq_withdraw_share_15m", "liq_deposit_share_15m"];
/** Features that need 15 minutes of observation. */
const WINDOW_15M_FEATURES = ["ret_15m", "volume_15m", "volume_persistence", "liq_withdraw_share_15m", "liq_deposit_share_15m"];
/** Features comparing the last 60s with the 60s before. */
const WINDOW_60S_PREV_FEATURES = ["volume_accel_60s", "buyer_accel", "new_buyers_60s", "buyer_velocity", "price_volume_divergence"];
/** Features that are only meaningful when the token was observed since creation. */
const CREATION_DEPENDENT_FEATURES = [
  "holders",
  "holders_log",
  "holder_growth_60s",
  "holder_growth_5m",
  "top1_share",
  "top10_share",
  "holder_entropy",
  "holder_gini",
  "first_buyers_retention",
  "creator_share",
  "creator_sold",
  "creator_sold_frac",
  "unique_traders_total",
  "since_ath_sec",
  "drawdown_from_ath",
];

export function holderStats(t: TokenState): {
  count: number;
  top1: number;
  top10: number;
  entropy: number;
  gini: number;
  creatorShare: number;
  firstBuyersRetention: number;
} {
  const circulatingTotal = Number(t.supply) / 10 ** t.decimals;
  const balances: number[] = [];
  let held = 0;
  for (const h of t.holders.values()) {
    if (h.balance > 0) {
      balances.push(h.balance);
      held += h.balance;
    }
  }
  balances.sort((a, b) => b - a);
  const top1 = balances[0] ?? 0;
  let top10 = 0;
  for (let i = 0; i < Math.min(10, balances.length); i++) top10 += balances[i] as number;
  let entropy = 0;
  let giniNum = 0;
  if (held > 0 && balances.length > 1) {
    for (const b of balances) {
      const p = b / held;
      entropy -= p * Math.log(p);
    }
    entropy /= Math.log(balances.length);
    // Gini on sorted ascending
    const asc = [...balances].reverse();
    let cum = 0;
    for (let i = 0; i < asc.length; i++) {
      cum += asc[i] as number;
      giniNum += cum;
    }
    giniNum = 1 - (2 * giniNum) / (asc.length * held) + 1 / asc.length;
  }
  const creatorBal = t.creator ? (t.holders.get(t.creator)?.balance ?? 0) : 0;
  const retained = t.firstBuyers.filter((b) => (t.holders.get(b)?.balance ?? 0) > 0).length;
  return {
    count: balances.length,
    top1: top1 / (circulatingTotal + EPS),
    top10: top10 / (circulatingTotal + EPS),
    entropy,
    gini: Math.max(0, giniNum),
    creatorShare: creatorBal / (circulatingTotal + EPS),
    firstBuyersRetention: t.firstBuyers.length > 0 ? retained / t.firstBuyers.length : 1,
  };
}

function walletFlow(
  buyers: Map<string, number>,
  sellers: Map<string, number>,
  ctx: FeatureContext,
  now: number,
): {
  smartBuyers: number;
  smartBuySol: number;
  smartSellSol: number;
  freshShare: number;
  experiencedShare: number;
  avgBuyerSkill: number;
  clusterMaxShare: number;
  distinctClusters: number;
} {
  let smartBuyers = 0;
  let smartBuySol = 0;
  let smartSellSol = 0;
  let fresh = 0;
  let experienced = 0;
  let skillSum = 0;
  let known = 0;
  let total = 0;
  const clusterSol = new Map<number, number>();
  let buySolTotal = 0;
  for (const [addr, sol] of buyers) {
    total++;
    buySolTotal += sol;
    const p = ctx.wallets.profile(addr);
    if (!p) {
      fresh++;
      continue;
    }
    known++;
    skillSum += p.skill;
    if (now - p.firstSeenAt < 24 * 3600 * SEC && p.trades < 5) fresh++;
    if (p.closedPositions >= 10) experienced++;
    if (p.skill > 0) {
      smartBuyers++;
      smartBuySol += sol;
    }
    if (p.clusterId !== null) clusterSol.set(p.clusterId, (clusterSol.get(p.clusterId) ?? 0) + sol);
  }
  for (const [addr, sol] of sellers) {
    const p = ctx.wallets.profile(addr);
    if (p && p.skill > 0) smartSellSol += sol;
  }
  let clusterMax = 0;
  for (const v of clusterSol.values()) if (v > clusterMax) clusterMax = v;
  return {
    smartBuyers,
    smartBuySol,
    smartSellSol,
    freshShare: total > 0 ? fresh / total : 0,
    experiencedShare: total > 0 ? experienced / total : 0,
    avgBuyerSkill: known > 0 ? skillSum / known : 0,
    clusterMaxShare: buySolTotal > 0 ? clusterMax / buySolTotal : 0,
    distinctClusters: clusterSol.size,
  };
}

/** Compute the base feature vector for `t` at time `now`. */
export function computeFeatures(t: TokenState, market: MarketState, now: number, ctx: FeatureContext): FeatureVector {
  const f: FeatureVector = {};
  const tape = t.tape;
  const w = (sec: number, offsetSec = 0): WindowStats => tape.window(now - (sec + offsetSec) * SEC, now - offsetSec * SEC);
  const w10 = w(10);
  const w30 = w(30);
  const w30p = w(30, 30);
  const w60 = w(60);
  const w60p = w(60, 60);
  const w300 = w(300);
  const w300p = w(300, 300);
  const w900 = w(900);

  const price = tape.priceAt(now) ?? t.lastPrice;
  const liq = t.liquiditySol;
  const mcap = price * (Number(t.supply) / 10 ** t.decimals);

  // lifecycle
  const age = t.ageAt(now);
  f.age_sec = age;
  f.log_age = Math.log1p(age);
  f.is_amm = t.venue === "pump_amm" ? 1 : 0;
  f.is_mayhem = t.isMayhem ? 1 : 0;
  f.bonding_progress = t.bondingProgress;
  f.seen_from_creation = t.seenFromCreation ? 1 : 0;
  f.since_last_trade_sec = t.lastTradeAt > 0 ? Math.max(0, (now - t.lastTradeAt) / SEC) : age;
  f.since_ath_sec = t.athAt > 0 ? Math.max(0, (now - t.athAt) / SEC) : age;
  if (t.migratedAt !== null) f.since_migration_sec = Math.max(0, (now - t.migratedAt) / SEC);

  // price & returns
  f.price_sol = price;
  f.log_mcap = Math.log1p(mcap);
  f.market_cap_sol = mcap;
  f.ret_10s = logRet(w10.firstPrice, price);
  f.ret_30s = logRet(w30.firstPrice, price);
  f.ret_60s = logRet(w60.firstPrice, price);
  f.ret_5m = logRet(w300.firstPrice, price);
  f.ret_15m = logRet(w900.firstPrice, price);
  f.ret_prev_30s = logRet(w30p.firstPrice, w30p.lastPrice);
  f.price_accel_30s = f.ret_30s - f.ret_prev_30s;
  f.drawdown_from_ath = t.athPrice > 0 ? price / t.athPrice - 1 : 0;
  f.runup_from_low_5m = w300.low > 0 && Number.isFinite(w300.low) ? price / w300.low - 1 : 0;
  f.range_5m = w300.low > 0 && Number.isFinite(w300.high) ? w300.high / w300.low - 1 : 0;
  f.volatility_60s = w60.volatility;
  f.volatility_5m = w300.volatility;
  f.vol_expansion = ratio(w60.volatility, w300.volatility);

  // volume & flow
  f.volume_10s = w10.volSol;
  f.volume_30s = w30.volSol;
  f.volume_60s = w60.volSol;
  f.volume_5m = w300.volSol;
  f.volume_15m = w900.volSol;
  f.buy_volume_60s = w60.buyVolSol;
  f.sell_volume_60s = w60.sellVolSol;
  f.net_flow_60s = w60.netFlowSol;
  f.net_flow_5m = w300.netFlowSol;
  f.buy_ratio_60s = w60.volSol > 0 ? w60.buyVolSol / w60.volSol : 0.5;
  f.buy_ratio_5m = w300.volSol > 0 ? w300.buyVolSol / w300.volSol : 0.5;
  f.buy_count_ratio_60s = w60.trades > 0 ? w60.buys / w60.trades : 0.5;
  f.trades_10s = w10.trades;
  f.trades_60s = w60.trades;
  f.trades_5m = w300.trades;
  f.trade_accel_30s = ratio(w30.trades, w30p.trades + 1);
  f.volume_accel_60s = ratio(w60.volSol, w60p.volSol + 0.01);
  f.volume_accel_5m = ratio(w300.volSol, w300p.volSol + 0.05);
  f.volume_velocity = w60.volSol / 60;
  f.avg_trade_sol_60s = w60.trades > 0 ? w60.volSol / w60.trades : 0;
  f.max_buy_sol_60s = w60.maxBuySol;
  f.max_sell_sol_60s = w60.maxSellSol;
  f.max_buy_share_60s = w60.buyVolSol > 0 ? w60.maxBuySol / w60.buyVolSol : 0;
  f.volume_to_mcap_5m = ratio(w300.volSol, mcap);
  f.volume_to_liq_5m = ratio(w300.volSol, liq);
  f.volume_persistence = w900.volSol > 0 ? Math.min(1, (3 * w300.volSol) / w900.volSol) : 0;
  f.price_volume_divergence = Math.sign(f.ret_60s) * -Math.sign(Math.log(f.volume_accel_60s + EPS));

  // participants
  f.unique_buyers_60s = w60.uniqueBuyers;
  f.unique_sellers_60s = w60.uniqueSellers;
  f.unique_buyers_5m = w300.uniqueBuyers;
  f.unique_traders_total = t.traderFirstSeen.size;
  const seenBefore = (trader: string, before: number) => {
    const first = t.traderFirstSeen.get(trader);
    return first !== undefined && first <= before;
  };
  const newBuyers60 = tape.newBuyers(now - 60 * SEC, now, seenBefore);
  const newBuyers60p = tape.newBuyers(now - 120 * SEC, now - 60 * SEC, seenBefore);
  f.new_buyers_60s = newBuyers60;
  f.buyer_velocity = newBuyers60 / 60;
  f.buyer_accel = ratio(newBuyers60, newBuyers60p + 1);
  f.seller_buyer_ratio_60s = ratio(w60.uniqueSellers, w60.uniqueBuyers + 1);
  f.max_buyers_same_slot_60s = w60.maxBuyersSameSlot;

  // holders
  const hs = holderStats(t);
  f.holders = hs.count;
  f.holders_log = Math.log1p(hs.count);
  f.holder_growth_60s = hs.count - t.holderCountAt(now - 60 * SEC);
  f.holder_growth_5m = hs.count - t.holderCountAt(now - 300 * SEC);
  f.top1_share = hs.top1;
  f.top10_share = hs.top10;
  f.holder_entropy = hs.entropy;
  f.holder_gini = hs.gini;
  f.first_buyers_retention = hs.firstBuyersRetention;

  // creator
  f.creator_share = hs.creatorShare;
  f.creator_sold = t.creatorSoldTokens > 0 ? 1 : 0;
  f.creator_sold_frac = t.creatorBoughtTokens > 0 ? Math.min(1, t.creatorSoldTokens / t.creatorBoughtTokens) : 0;
  if (t.creator) {
    const c = ctx.creators.creator(t.creator);
    if (c) {
      f.creator_prev_tokens = c.tokensCreated;
      f.creator_completion_rate = c.tokensCreated > 0 ? c.tokensCompleted / c.tokensCreated : 0;
      f.creator_dump_rate = c.tokensCreated > 0 ? c.quickDumps / c.tokensCreated : 0;
    } else {
      f.creator_prev_tokens = 0;
    }
  }

  // liquidity
  f.liquidity_sol = liq;
  f.liq_to_mcap = ratio(liq, mcap);
  const liqWithdraw15m = t.liquidityEvents
    .filter((e) => e.kind === "withdraw" && e.ts > now - 900 * SEC && e.ts <= now)
    .reduce((s, e) => s + e.quoteSol, 0);
  const liqDeposit15m = t.liquidityEvents
    .filter((e) => e.kind === "deposit" && e.ts > now - 900 * SEC && e.ts <= now)
    .reduce((s, e) => s + e.quoteSol, 0);
  f.liq_withdraw_share_15m = ratio(liqWithdraw15m, liq + liqWithdraw15m);
  f.liq_deposit_share_15m = ratio(liqDeposit15m, liq);
  f.fee_bps = t.lastFeeBps ?? 0;

  // wallet intelligence (evidence-based)
  const buyers60 = tape.buyersIn(now - 60 * SEC, now);
  const sellers60 = tape.sellersIn(now - 60 * SEC, now);
  const wf = walletFlow(buyers60, sellers60, ctx, now);
  f.smart_buyers_60s = wf.smartBuyers;
  f.smart_buy_sol_60s = wf.smartBuySol;
  f.smart_net_flow_60s = wf.smartBuySol - wf.smartSellSol;
  f.fresh_wallet_share_60s = wf.freshShare;
  f.experienced_wallet_share_60s = wf.experiencedShare;
  f.avg_buyer_skill_60s = wf.avgBuyerSkill;
  f.cluster_max_share_60s = wf.clusterMaxShare;
  f.distinct_clusters_60s = wf.distinctClusters;

  // composite scores (transparent formulas, not magic numbers)
  f.buy_pressure = f.buy_ratio_60s * Math.log1p(w60.buyVolSol);
  f.sell_pressure = (1 - f.buy_ratio_60s) * Math.log1p(w60.sellVolSol);
  f.momentum_score = f.ret_60s + 0.5 * f.ret_5m;
  f.activity_score = Math.log1p(w60.trades) + Math.log1p(w60.uniqueTraders);

  // events (seconds since last event of each type, capped)
  if (ctx.eventAges) {
    for (const [type, ageSec] of Object.entries(ctx.eventAges)) {
      f[`ev_${type}_age`] = Math.min(EVENT_AGE_CAP_SEC, ageSec);
    }
  }

  // market context
  if (ctx.market) {
    for (const [k, v] of Object.entries(ctx.market)) f[`mkt_${k}`] = v;
  }

  // coverage: drop features whose window exceeds the observed period (missing instead of wrong)
  const coverage = t.coverageAt(now);
  f.coverage_sec = coverage;
  // (tokens observed since creation have complete windows: time before creation is genuinely empty)
  if (!t.seenFromCreation) {
    if (coverage < 300) for (const k of WINDOW_5M_FEATURES) delete f[k];
    if (coverage < 900) for (const k of WINDOW_15M_FEATURES) delete f[k];
    if (coverage < 120) for (const k of WINDOW_60S_PREV_FEATURES) delete f[k];
    for (const k of CREATION_DEPENDENT_FEATURES) delete f[k];
  }

  // sanitize
  for (const [k, v] of Object.entries(f)) {
    if (!Number.isFinite(v)) delete f[k];
  }
  void market;
  return f;
}

/** Round features to 6 significant digits for storage. */
export function compactFeatures(f: FeatureVector): FeatureVector {
  const out: FeatureVector = {};
  for (const [k, v] of Object.entries(f)) out[k] = v === 0 ? 0 : Number(v.toPrecision(6));
  return out;
}
