import type { BotState, CircuitBreakerId, LiveGateState, NotificationType, Severity } from "./enums.js";

/** Realtime events (worker → Redis → API → browser WebSocket). Payloads are JSON (bigints as strings). */
export const REALTIME_EVENTS = [
  "QUOTE_UPDATED",
  "OPPORTUNITY_DETECTED",
  "OPPORTUNITY_REJECTED",
  "PAPER_TRADE_CREATED",
  "PAPER_TRADE_CLOSED",
  "LIVE_TRADE_CREATED",
  "LIVE_TRADE_CLOSED",
  "TRANSACTION_SUBMITTED",
  "TRANSACTION_CONFIRMED",
  "TRANSACTION_FAILED",
  "WALLET_UPDATED",
  "P&L_UPDATED",
  "RISK_TRIGGERED",
  "LEARNING_UPDATED",
  "SYSTEM_ERROR",
  "STATUS_UPDATED",
  "NOTIFICATION",
  "LOG",
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENTS)[number];

export interface RealtimeEvent<T = unknown> {
  type: RealtimeEventType;
  ts: number;
  payload: T;
}

/** Commands from the API to the worker (Redis channel + authoritative DB state). */
export type ControlCommand =
  | { type: "BOT_START" }
  | { type: "BOT_STOP" }
  | { type: "PAUSE"; reason: string }
  | { type: "RESUME" }
  | { type: "EMERGENCY_STOP"; reason: string }
  | { type: "EMERGENCY_RELEASE" }
  | { type: "LIVE_ENABLE"; actor: string }
  | { type: "LIVE_DISABLE"; actor: string }
  | { type: "LIVE_LEVEL_SET"; level: number; actor: string }
  | { type: "SETTINGS_CHANGED" }
  | { type: "BREAKER_RESET"; breaker: CircuitBreakerId; actor: string }
  | { type: "SHADOW_SET"; enabled: boolean }
  | { type: "RUN_OPTIMIZATION" }
  | { type: "REFRESH_WALLET" }
  | { type: "PAPER_RESET"; capitalEur: number; actor: string };

export interface ComponentHealth {
  name: string;
  status: "CONNECTED" | "DEGRADED" | "DISCONNECTED" | "DISABLED" | "UNKNOWN";
  detail?: string;
  lastError?: string | null;
  latencyMs?: number | null;
}

/** Snapshot the worker publishes every few seconds (also cached in Redis for the API). */
export interface WorkerStatus {
  ts: number;
  botState: BotState;
  liveGate: LiveGateState;
  liveEnvAllowed: boolean;
  shadow: boolean;
  ready: boolean;
  notReadyReasons: string[];
  startedAt: number;
  components: ComponentHealth[];
  breakers: { id: CircuitBreakerId; open: boolean; since: number | null; reason: string | null; liveOnly: boolean }[];
  solEur: number | null;
  solEurAt: number | null;
  slot: number | null;
  quoteBudget: { rps: number; used1m: number; limit1m: number };
  scanner: { pools: number; tokens: number; lastScanAt: number | null; candidates1m: number; screened1m: number };
  learning: { score: number; status: string };
  wallet: { configured: boolean; address: string | null; balanceLamports: string | null };
  metrics: { cpuPct: number; rssMb: number; heapMb: number; eventLoopLagMs: number };
}

export interface NotificationDto {
  id: number;
  ts: string;
  type: NotificationType;
  severity: Severity;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
}
