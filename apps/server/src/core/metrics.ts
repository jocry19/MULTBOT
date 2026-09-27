import client from "prom-client";

/** Prometheus metrics (exposed at /metrics). One registry per process. */
export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry, prefix: "multbot_" });

export const metrics = {
  rpcRequests: new client.Counter({
    name: "multbot_rpc_requests_total",
    help: "RPC requests by endpoint, method and outcome",
    labelNames: ["endpoint", "method", "outcome"] as const,
    registers: [metricsRegistry],
  }),
  rpcLatency: new client.Histogram({
    name: "multbot_rpc_latency_seconds",
    help: "RPC latency",
    labelNames: ["endpoint"] as const,
    buckets: [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [metricsRegistry],
  }),
  wsMessages: new client.Counter({
    name: "multbot_ws_messages_total",
    help: "WebSocket notifications received",
    labelNames: ["endpoint"] as const,
    registers: [metricsRegistry],
  }),
  wsReconnects: new client.Counter({
    name: "multbot_ws_reconnects_total",
    help: "WebSocket reconnects",
    labelNames: ["endpoint"] as const,
    registers: [metricsRegistry],
  }),
  decodedEvents: new client.Counter({
    name: "multbot_decoded_events_total",
    help: "Decoded on-chain events",
    labelNames: ["event"] as const,
    registers: [metricsRegistry],
  }),
  decodeErrors: new client.Counter({
    name: "multbot_decode_errors_total",
    help: "Event decode failures",
    registers: [metricsRegistry],
  }),
  dbWriteLatency: new client.Histogram({
    name: "multbot_db_batch_write_seconds",
    help: "Batch write latency",
    labelNames: ["table"] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [metricsRegistry],
  }),
  signals: new client.Counter({
    name: "multbot_signals_total",
    help: "Strategy signals by mode and decision",
    labelNames: ["mode", "decision"] as const,
    registers: [metricsRegistry],
  }),
  executions: new client.Counter({
    name: "multbot_executions_total",
    help: "Live executions by side and outcome",
    labelNames: ["side", "outcome"] as const,
    registers: [metricsRegistry],
  }),
};
