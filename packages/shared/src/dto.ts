import type {
  ActivityLevel,
  ComponentStatus,
  EngineState,
  LiveTradingState,
  ReconciliationState,
} from "./enums.js";

/** Wire types used by the dashboard API. Server responses must match these shapes. */

export interface SystemHealthDto {
  rpc: ComponentStatus;
  dataFeed: ComponentStatus;
  database: ComponentStatus;
  wallet: ComponentStatus;
  tradingEngine: EngineState;
  paperEngine: EngineState;
  liveTrading: LiveTradingState;
  reconciliation: ReconciliationState;
  emergencyStop: boolean;
  modules: ModuleHealthDto[];
  rpcEndpoints: RpcEndpointHealthDto[];
  ingest: {
    lastEventAt: string | null;
    eventsPerMinute: number;
    decodeErrors: number;
  };
  serverTime: string;
}

export interface ModuleHealthDto {
  name: string;
  state: EngineState;
  status: ComponentStatus;
  detail?: string;
  lastError?: string | null;
}

export interface RpcEndpointHealthDto {
  name: string;
  kind: string;
  status: ComponentStatus;
  latencyMs: number | null;
  slot: number | null;
  slotLag: number | null;
  wsConnected: boolean;
  errorRate: number;
  requests: number;
}

export interface ActivityDto {
  id: number;
  ts: string;
  level: ActivityLevel;
  category: string;
  message: string;
  data?: Record<string, unknown> | null;
}

/** Real-time messages pushed over the dashboard WebSocket. */
export type StreamMessage =
  | { type: "activity"; payload: ActivityDto }
  | { type: "health"; payload: SystemHealthDto }
  | { type: "invalidate"; payload: { keys: string[] } };
