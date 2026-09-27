/** Response shapes of the dashboard API (subset used by the UI). */

export interface PortfolioSummary {
  mode: "paper" | "live";
  capitalSol: number;
  cashSol: number;
  lockedSol: number;
  positionsValueSol: number;
  portfolioValueSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  todayPnlSol: number;
  totalPnlSol: number;
  grossPnlSol: number;
  feesSol: number;
  slippageSol: number;
  openPositions: number;
  closedTrades: number;
  failedTrades: number;
}

export interface Dashboard {
  wallet: { address: string | null; balanceSol: number | null; availableSol: number | null; lockedSol: number; reserveSol: number };
  live: PortfolioSummary;
  paper: PortfolioSummary;
  strategies: { active: number; validated: number };
  trades: { paper: number; live: number };
  regime: { label: string; levels: Record<string, string>; metrics: Record<string, number> } | null;
  bot: { running: boolean; liveState: string; emergencyStop: boolean; reconciliation: string };
  market: { tokens: number; eventsPerMinute: number };
}

export interface DiscoveryReason {
  type: string;
  label: string;
  severity: number;
  ts: number;
}

export interface TokenRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  venue: string;
  price_sol: number | null;
  market_cap_sol: number | null;
  liquidity_sol: number | null;
  volume_sol_5m: number | null;
  volume_sol_1h: number | null;
  volume_sol_24h?: number | null;
  price_change_5m: number | null;
  price_change_1h?: number | null;
  holders: number | null;
  buys_5m?: number | null;
  sells_5m?: number | null;
  bonding_progress?: number | null;
  discovery_score: number | null;
  discovery_reasons: DiscoveryReason[];
  created_at: string | null;
  last_trade_at?: string | null;
  updated_at?: string;
  is_mayhem_mode?: boolean;
  top10_share?: number | null;
  unique_traders?: number | null;
  trades_total?: number | null;
  ath_price_sol?: number | null;
}

export interface StrategyRow {
  id: string;
  name: string;
  family: string;
  origin: string;
  status: string;
  status_reason: string | null;
  current_version_id: string | null;
  version: string | null;
  live_enabled: boolean;
  paper_enabled: boolean;
  created_at: string;
  spec: { horizonSec: number; exit: { takeProfitPct?: number; stopLossPct?: number; maxHoldSec: number }; universe: { venues: string[] } } | null;
  description: string[];
  discovery: Evidence | null;
  backtest: { stats?: Perf; passed?: boolean; reason?: string; backtestId?: number; netPnlSol?: number; grossPnlSol?: number } | null;
  paper: { stats?: Perf; rolling?: Rolling; confidence?: number } | null;
  paper_trades: number;
  live_trades: number;
  live_net_sol: number | null;
}

export interface Perf {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  mean: number;
  median: number;
  std: number;
  sum: number;
  best: number;
  worst: number;
  p05: number;
  p95: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  tStat: number;
  pValue: number;
  tailLoss: number;
}

export interface SplitStats {
  n: number;
  mean: number;
  median: number;
  winRate: number;
  pValue: number;
  worst: number;
  best: number;
  maxDrawdown: number;
  profitFactor: number;
  tailLoss: number;
}

export interface Evidence {
  runId: number;
  target: string;
  recipe: string[];
  occurrences: number;
  train: SplitStats;
  validation: SplitStats | null;
  holdout: SplitStats | null;
  walkForward: { folds: { n: number; mean: number; winRate: number }[]; positiveShare: number; mean: number } | null;
  multipleTesting: { hypothesesTested: number; pValue: number; qValue: number; fdrAlpha: number };
  overfit: { dsr: number; sharpeTrain: number; sharpeOos: number | null; oosRetention: number | null };
  regimes: { label: string; n: number; mean: number; winRate: number }[];
  nearMisses: { dropped: string; n: number; mean: number; delta: number }[];
  worstTrades: { mint: string; ts: number; ret: number }[];
  costShare: number | null;
  baselineMean: number;
  whyItMightFail: string[];
  samplePeriod: { from: number; to: number };
}

export interface Rolling {
  window: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  decayPValue: number | null;
  featureShift: { feature: string; psi: number }[];
}

export interface TradeRow {
  id: string;
  strategy_id: string;
  strategy_version_id: string;
  mint: string;
  symbol: string | null;
  status: string;
  decision_ts: string;
  opened_at: string | null;
  closed_at: string | null;
  position_size_sol: number;
  entry_price: number | null;
  exit_price: number | null;
  gross_pnl_sol: number | null;
  net_pnl_sol: number | null;
  net_return: number | null;
  exit_reason: string | null;
  failed_reason: string | null;
  entry_fees_sol: number;
  exit_fees_sol: number;
  entry_slippage_sol: number;
  exit_slippage_sol: number;
  priority_fees_sol: number;
  network_fees_sol: number;
  mev_impact_sol: number;
  entry_rent_sol: number;
  exit_rent_refund_sol: number;
  max_runup: number | null;
  max_drawdown: number | null;
  entry_signature?: string | null;
  exit_signature?: string | null;
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  regime: { label?: string } | null;
}

export interface PositionRow extends TradeRow {
  valueSol: number;
  unrealizedSol: number;
  token_qty: string | null;
}
