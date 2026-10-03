export interface PortfolioSnapshot {
  mode: "paper" | "live";
  balanceLamports: string;
  startingLamports: string;
  equityEur: number;
  realizedEur: number;
  pnlTodayEur: number;
  drawdownEur: number;
  maxDrawdownEur: number;
  trades: number;
  wins: number;
  losses: number;
  failures: number;
  openTrades: number;
  consecutiveFailures: number;
  lossStreak: number;
  lastTradeSizeEur: number | null;
  lastTradeLost: boolean;
  expectancyEur: number | null;
}

export interface PerformanceResponse {
  mode: string;
  /** paper: start of the current paper account (earlier paper trades are history) */
  since?: string;
  portfolio: PortfolioSnapshot | null;
  solEur: number | null;
  stats: { trades: number; wins: number; losses: number; net_eur: number; expectancy_eur: number; avg_prediction_error_bps: number; best_eur: number; worst_eur: number; avg_size_eur: number } | null;
  daily: { day: string; net_eur: number; trades: number }[];
}

export interface WhyNoTrade {
  hours: number;
  quoteStage: { reason: string; strategyType: string; count: number }[];
  screeningStage: { reason: string; strategyType: string; count: number }[];
  executable: number;
}

export interface ChartsResponse {
  hours: number;
  bucket: string;
  equityPaper: { ts: string; equity: number }[];
  equityLive: { ts: string; equity: number }[];
  dailyPnl: { day: string; paper: number; live: number }[];
  oppsOverTime: { t: string; status: string; n: number }[];
  rejections: { reason: string; n: number }[];
  spreadHist: { b: number; n: number }[];
  predVsReal: { predicted_eur: number; realized_eur: number; success: boolean }[];
  slippage: { ts: string; predicted: number; realized: number }[];
  latency: { b: number; n: number }[];
  calibration: { b: number; predicted: number; realized: number; n: number }[];
  fees: { mode: string; kind: string; lamports: string; eur: number }[];
  learningScore: { ts: string; score: number; status: string }[];
}

export interface GateCheck {
  name: string;
  ok: boolean;
  value: string;
  required: string;
}

export interface LearningSnapshot {
  samples: number;
  successRate: number | null;
  executionModelTrained: boolean;
  expectedSlippageBps: number;
  slippageStdBps: number;
  latencyMs: number;
  latencySamples: number;
  score: number;
  status: string;
  gate: { ready: boolean; checks: GateCheck[] };
  report: {
    train: SetPerf;
    validation: SetPerf;
    oos: SetPerf;
    walkForward: { fold: number; test: SetPerf; executionAccuracy: number | null }[];
    executionAccuracy: number | null;
    slippageAccuracy: number | null;
    feeAccuracy: number | null;
    stable: boolean;
  } | null;
  counts: { paperOpportunities: number; simulatedExecutions: number; latencySamples: number };
  strategyVersionId: string | null;
}

export interface SetPerf {
  n: number;
  netEur: number;
  expectancyEur: number;
  winRate: number;
  failureRate: number;
  maxDrawdownEur: number;
  pValue: number;
}
