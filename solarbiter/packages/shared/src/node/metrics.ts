import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Prometheus metrics shared by worker and API. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "solarbiter_" });

export const metrics = {
  rpcLatency: new Histogram({ name: "solarbiter_rpc_latency_ms", help: "RPC request latency", labelNames: ["endpoint", "method"], buckets: [25, 50, 100, 200, 400, 800, 1600, 3200], registers: [registry] }),
  quoteLatency: new Histogram({ name: "solarbiter_quote_latency_ms", help: "Firm quote latency", labelNames: ["source"], buckets: [50, 100, 200, 400, 800, 1600, 3200], registers: [registry] }),
  executionLatency: new Histogram({ name: "solarbiter_execution_latency_ms", help: "Submit → confirmation latency", labelNames: ["mode"], buckets: [200, 400, 800, 1600, 3200, 6400, 12800], registers: [registry] }),
  opportunities: new Counter({ name: "solarbiter_opportunities_total", help: "Opportunities by outcome", labelNames: ["type", "status", "reason"], registers: [registry] }),
  screened: new Counter({ name: "solarbiter_screened_total", help: "Pool pairs screened", registers: [registry] }),
  txs: new Counter({ name: "solarbiter_transactions_total", help: "Transactions by status", labelNames: ["mode", "status"], registers: [registry] }),
  jitoBundles: new Counter({ name: "solarbiter_jito_bundles_total", help: "Jito bundles by status", labelNames: ["status"], registers: [registry] }),
  walletLamports: new Gauge({ name: "solarbiter_wallet_lamports", help: "Bot wallet SOL balance", registers: [registry] }),
  breakerOpen: new Gauge({ name: "solarbiter_circuit_breaker_open", help: "1 if a circuit breaker is open", labelNames: ["breaker"], registers: [registry] }),
};

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();

/** Process resource snapshot (CPU % since the previous call, memory, event-loop lag p99). */
export function processMetrics(): { cpuPct: number; rssMb: number; heapMb: number; eventLoopLagMs: number; loadAvg: number } {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastAt) / 1000;
  lastCpu = process.cpuUsage();
  lastAt = now;
  const mem = process.memoryUsage();
  const lag = loop.percentile(99) / 1e6;
  loop.reset();
  return {
    cpuPct: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0,
    rssMb: Math.round(mem.rss / 1e6),
    heapMb: Math.round(mem.heapUsed / 1e6),
    eventLoopLagMs: Math.round(lag * 10) / 10,
    loadAvg: os.loadavg()[0] ?? 0,
  };
}
