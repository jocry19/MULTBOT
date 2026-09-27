import type { LiveTradingState, ReconciliationState, Settings } from "@multbot/shared";

/**
 * Risk checks before every live entry (and before exits). Pure function over a snapshot so the
 * decision and all reasons are transparent and testable. "NO TRADE" is a valid, logged outcome.
 */

export interface RiskSnapshot {
  now: number;
  settings: Settings;
  liveState: LiveTradingState;
  botRunning: boolean;
  reconciliation: ReconciliationState;
  walletLamports: number | null;
  openPositions: { mint: string; costSol: number }[];
  realizedTodaySol: number;
  unrealizedSol: number;
  /** Last time market data for this token was received. */
  tokenDataAt: number | null;
  rpcHealthy: boolean;
  strategy: { id: string; versionId: string; status: string; liveEnabled: boolean };
}

export interface EntryRequest {
  mint: string;
  positionSizeSol: number;
  expectedPriceImpactBps: number | null;
  estimatedFeesSol: number;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
  checks: Record<string, boolean>;
}

function inTradingHours(s: Settings, now: number): boolean {
  const h = s.risk.tradingHours;
  if (!h.enabled) return true;
  const d = new Date(now);
  if (!h.days.includes(d.getUTCDay())) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [sh, sm] = h.startUtc.split(":").map(Number) as [number, number];
  const [eh, em] = h.endUtc.split(":").map(Number) as [number, number];
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

export function checkEntry(snap: RiskSnapshot, req: EntryRequest): RiskDecision {
  const s = snap.settings;
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];
  const add = (name: string, ok: boolean, reason: string) => {
    checks[name] = ok;
    if (!ok) reasons.push(reason);
  };
  add("emergencyStop", !s.risk.emergencyStop, "EMERGENCY STOP active");
  add("liveUnlocked", snap.liveState === "ACTIVE", "real money mode is LOCKED");
  add("botRunning", snap.botRunning, "bot is stopped");
  add("entriesNotPaused", !s.risk.pauseEntries, "entries are paused");
  add("reconciliation", snap.reconciliation === "OK", "reconciliation required — no new trades until resolved");
  add("tradingHours", inTradingHours(s, snap.now), "outside configured trading hours");
  add("strategyStatus", snap.strategy.status === "LIVE_ENABLED" && snap.strategy.liveEnabled, `strategy ${snap.strategy.id} is not enabled for live trading`);
  const allowedIds = s.risk.allowedStrategyIds;
  const allowedVersions = s.risk.allowedStrategyVersionIds;
  add(
    "strategyAllowed",
    (allowedIds.length === 0 || allowedIds.includes(snap.strategy.id)) && (allowedVersions.length === 0 || allowedVersions.includes(snap.strategy.versionId)),
    "strategy/version not in the allowed list",
  );
  add("maxPositions", snap.openPositions.length < s.trading.maxOpenPositions, `max open positions (${s.trading.maxOpenPositions}) reached`);
  add("positionSize", req.positionSizeSol <= s.trading.positionSizeSol + 1e-12, "position size above configured size");
  const exposure = snap.openPositions.reduce((a, p) => a + p.costSol, 0);
  add("portfolioExposure", exposure + req.positionSizeSol <= s.risk.maxPortfolioExposureSol + 1e-12, "max portfolio exposure would be exceeded");
  const tokenExposure = snap.openPositions.filter((p) => p.mint === req.mint).reduce((a, p) => a + p.costSol, 0);
  add("tokenExposure", tokenExposure + req.positionSizeSol <= s.risk.maxTokenExposureSol + 1e-12, "max exposure for this token would be exceeded");
  add("noDuplicateToken", !snap.openPositions.some((p) => p.mint === req.mint), "already holding this token");
  add("dailyLoss", snap.realizedTodaySol + Math.min(0, snap.unrealizedSol) > -s.risk.maxDailyLossSol, "max daily loss reached");
  const needed = (req.positionSizeSol + req.estimatedFeesSol + s.risk.minWalletReserveSol) * 1e9;
  add("walletBalance", snap.walletLamports !== null && snap.walletLamports >= needed, "insufficient SOL (position + fees + reserve)");
  add("dataFresh", snap.tokenDataAt !== null && snap.now - snap.tokenDataAt <= s.risk.maxDataStalenessSec * 1000, "market data is stale");
  add("rpcHealthy", snap.rpcHealthy, "RPC unhealthy");
  add(
    "slippage",
    req.expectedPriceImpactBps === null || req.expectedPriceImpactBps <= s.trading.maxSlippageBps,
    "expected price impact exceeds max slippage",
  );
  return { allowed: reasons.length === 0, reasons, checks };
}

export function checkExit(snap: Pick<RiskSnapshot, "settings" | "rpcHealthy">, manual: boolean): RiskDecision {
  const reasons: string[] = [];
  if (snap.settings.risk.pauseExits && !manual) reasons.push("exits are paused");
  if (!snap.rpcHealthy) reasons.push("RPC unhealthy");
  return { allowed: reasons.length === 0, reasons, checks: { exitsNotPaused: !snap.settings.risk.pauseExits || manual, rpcHealthy: snap.rpcHealthy } };
}
