import type { ComponentStatus } from "@multbot/shared";
import type { Logger } from "pino";
import WebSocket from "ws";
import { metrics } from "../../core/metrics.js";
import { backoffDelay } from "../../core/retry.js";

/**
 * Resilient Solana PubSub client.
 *
 *  - keeps a list of desired subscriptions and re-subscribes after every reconnect
 *  - reconnects with bounded exponential backoff, rotating through endpoints (failover)
 *  - ping/pong heartbeat + staleness watchdog (no notifications for too long → reconnect)
 *  - one-shot subscriptions (signatureSubscribe) are removed after their notification
 */

export type SubscribeMethod = "logsSubscribe" | "slotSubscribe" | "signatureSubscribe" | "accountSubscribe";

const UNSUBSCRIBE: Record<SubscribeMethod, string> = {
  logsSubscribe: "logsUnsubscribe",
  slotSubscribe: "slotUnsubscribe",
  signatureSubscribe: "signatureUnsubscribe",
  accountSubscribe: "accountUnsubscribe",
};

const NOTIFICATION: Record<string, SubscribeMethod> = {
  logsNotification: "logsSubscribe",
  slotNotification: "slotSubscribe",
  signatureNotification: "signatureSubscribe",
  accountNotification: "accountSubscribe",
};

interface Subscription {
  key: number;
  method: SubscribeMethod;
  params: unknown[];
  onNotification: (result: unknown) => void;
  oneShot: boolean;
  serverId: number | null;
  /** Expect continuous traffic; used by the staleness watchdog. */
  expectsFlow: boolean;
  lastNotificationAt: number;
}

export interface WsEndpoint {
  name: string;
  wsUrl: string;
}

export interface WsClientOptions {
  pingIntervalMs?: number;
  staleAfterMs?: number;
  maxBackoffMs?: number;
  /** For tests. */
  createSocket?: (url: string) => WebSocket;
}

export interface SubscriptionHandle {
  unsubscribe(): void;
}

export class SolanaWsClient {
  private ws: WebSocket | null = null;
  private endpointIndex = 0;
  private readonly subs = new Map<number, Subscription>();
  private readonly pending = new Map<number, { subKey: number; unsubscribe?: boolean }>();
  private nextKey = 1;
  private nextRequestId = 1;
  private connected = false;
  private closedByUser = true;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private lastMessageAt = 0;
  reconnects = 0;
  lastError: string | null = null;

  private readonly pingIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly endpoints: WsEndpoint[],
    private readonly log: Logger,
    private readonly opts: WsClientOptions = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? 15_000;
    this.staleAfterMs = opts.staleAfterMs ?? 45_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentEndpoint(): string | null {
    return this.endpoints[this.endpointIndex]?.name ?? null;
  }

  get lastMessageTime(): number {
    return this.lastMessageAt;
  }

  status(): ComponentStatus {
    if (this.endpoints.length === 0) return "DISABLED";
    if (this.closedByUser) return "DISCONNECTED";
    if (!this.connected) return "DISCONNECTED";
    const stale = this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > this.staleAfterMs;
    return stale ? "DEGRADED" : "CONNECTED";
  }

  start(): void {
    if (this.endpoints.length === 0) {
      this.log.warn("no websocket endpoints configured");
      return;
    }
    this.closedByUser = false;
    this.connect();
    this.watchdogTimer = setInterval(() => this.watchdog(), Math.min(5_000, this.staleAfterMs));
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.stopPing();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
    this.connected = false;
  }

  subscribe(
    method: SubscribeMethod,
    params: unknown[],
    onNotification: (result: unknown) => void,
    opts: { expectsFlow?: boolean } = {},
  ): SubscriptionHandle {
    const key = this.nextKey++;
    const sub: Subscription = {
      key,
      method,
      params,
      onNotification,
      oneShot: method === "signatureSubscribe",
      serverId: null,
      expectsFlow: opts.expectsFlow ?? method === "logsSubscribe",
      lastNotificationAt: Date.now(),
    };
    this.subs.set(key, sub);
    if (this.connected) this.sendSubscribe(sub);
    return { unsubscribe: () => this.unsubscribe(key) };
  }

  private unsubscribe(key: number): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (this.connected && sub.serverId !== null && !sub.oneShot) {
      const id = this.nextRequestId++;
      this.pending.set(id, { subKey: key, unsubscribe: true });
      this.send({ jsonrpc: "2.0", id, method: UNSUBSCRIBE[sub.method], params: [sub.serverId] });
    }
  }

  private connect(): void {
    const endpoint = this.endpoints[this.endpointIndex];
    if (!endpoint) return;
    this.log.info({ endpoint: endpoint.name }, "connecting websocket");
    const ws = this.opts.createSocket ? this.opts.createSocket(endpoint.wsUrl) : new WebSocket(endpoint.wsUrl, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.log.info({ endpoint: endpoint.name, subscriptions: this.subs.size }, "websocket connected");
      for (const sub of this.subs.values()) {
        sub.serverId = null;
        sub.lastNotificationAt = Date.now();
        this.sendSubscribe(sub);
      }
      this.startPing();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      metrics.wsMessages.inc({ endpoint: endpoint.name });
      this.handleMessage(raw.toString());
    });

    ws.on("pong", () => {
      this.awaitingPong = false;
    });

    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log.warn({ endpoint: endpoint.name, err: err.message }, "websocket error");
    });

    ws.on("close", (code: number) => {
      this.connected = false;
      this.stopPing();
      if (this.closedByUser) return;
      this.log.warn({ endpoint: endpoint.name, code }, "websocket closed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectAttempt++;
    this.reconnects++;
    metrics.wsReconnects.inc({ endpoint: this.currentEndpoint ?? "none" });
    // rotate endpoints after two consecutive failures (failover)
    if (this.reconnectAttempt % 2 === 0 && this.endpoints.length > 1) {
      this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    }
    const delay = backoffDelay(this.reconnectAttempt, 1_000, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ws?.removeAllListeners();
      this.ws?.terminate();
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Force a reconnect (used by watchdog and tests). */
  reconnect(reason: string): void {
    if (this.closedByUser) return;
    this.log.warn({ reason }, "forcing websocket reconnect");
    this.connected = false;
    this.stopPing();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
    this.scheduleReconnect();
  }

  private watchdog(): void {
    if (this.closedByUser || !this.connected) return;
    const now = Date.now();
    for (const sub of this.subs.values()) {
      if (sub.expectsFlow && now - sub.lastNotificationAt > this.staleAfterMs) {
        this.reconnect(`subscription ${sub.method} stale for ${Math.round((now - sub.lastNotificationAt) / 1000)}s`);
        return;
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      if (this.awaitingPong) {
        this.reconnect("pong timeout");
        return;
      }
      this.awaitingPong = true;
      try {
        this.ws.ping();
      } catch {
        this.reconnect("ping failed");
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.awaitingPong = false;
  }

  private sendSubscribe(sub: Subscription): void {
    const id = this.nextRequestId++;
    this.pending.set(id, { subKey: sub.key });
    this.send({ jsonrpc: "2.0", id, method: sub.method, params: sub.params });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: number; result: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!pending || pending.unsubscribe) return;
      const sub = this.subs.get(pending.subKey);
      if (!sub) return;
      if (msg.error) {
        this.lastError = msg.error.message;
        this.log.error({ method: sub.method, error: msg.error.message }, "subscription failed");
        return;
      }
      sub.serverId = msg.result as number;
      return;
    }
    if (msg.method && msg.params) {
      const method = NOTIFICATION[msg.method];
      if (!method) return;
      for (const sub of this.subs.values()) {
        if (sub.serverId === msg.params.subscription && sub.method === method) {
          sub.lastNotificationAt = Date.now();
          try {
            sub.onNotification(msg.params.result);
          } catch (err) {
            this.log.error({ err, method }, "notification handler failed");
          }
          if (sub.oneShot) this.subs.delete(sub.key);
          break;
        }
      }
    }
  }
}
