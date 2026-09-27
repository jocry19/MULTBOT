import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { ControlCommand, RealtimeEvent, RealtimeEventType } from "../events.js";
import { stringifyBig } from "../json.js";

export const CHANNEL_EVENTS = "sb:events";
export const CHANNEL_CONTROL = "sb:control";
export const KEY_WORKER_STATUS = "sb:worker:status";
export const KEY_WORKER_HEARTBEAT = "sb:worker:heartbeat";
export const KEY_SCANNER_TABLE = "sb:scanner:table";
export const KEY_MARKETS = "sb:markets";

/**
 * Redis transport between worker and API: realtime events (pub/sub), control commands (pub/sub,
 * mirrored in the database as the source of truth) and small cached snapshots.
 * Separate connections for publishing and subscribing (a subscribed connection cannot publish).
 */
export class RedisBus {
  readonly pub: Redis;
  private sub: Redis | null = null;
  private readonly eventHandlers = new Set<(e: RealtimeEvent) => void>();
  private readonly controlHandlers = new Set<(c: ControlCommand) => void>();
  private healthy = false;
  lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {
    this.pub = this.client("pub");
  }

  private client(role: string): Redis {
    const c = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    c.on("ready", () => {
      if (role === "pub") this.healthy = true;
    });
    c.on("error", (err: Error) => {
      if (role === "pub") this.healthy = false;
      this.lastError = err.message;
    });
    c.on("end", () => {
      if (role === "pub") this.healthy = false;
    });
    return c;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  async connect(): Promise<void> {
    await this.pub.connect();
    this.healthy = true;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await this.pub.ping();
    return Date.now() - t;
  }

  async publishEvent<T>(type: RealtimeEventType, payload: T): Promise<void> {
    if (!this.healthy) return;
    const e: RealtimeEvent<T> = { type, ts: Date.now(), payload };
    await this.pub.publish(CHANNEL_EVENTS, stringifyBig(e)).catch((err: Error) => this.log.debug({ err: err.message }, "event publish failed"));
  }

  async publishControl(cmd: ControlCommand): Promise<void> {
    await this.pub.publish(CHANNEL_CONTROL, JSON.stringify(cmd));
  }

  async setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    if (!this.healthy) return;
    const s = stringifyBig(value);
    if (ttlSec) await this.pub.set(key, s, "EX", ttlSec);
    else await this.pub.set(key, s);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const s = await this.pub.get(key);
    return s ? (JSON.parse(s) as T) : null;
  }

  onEvent(fn: (e: RealtimeEvent) => void): () => void {
    this.eventHandlers.add(fn);
    return () => this.eventHandlers.delete(fn);
  }

  onControl(fn: (c: ControlCommand) => void): () => void {
    this.controlHandlers.add(fn);
    return () => this.controlHandlers.delete(fn);
  }

  /** Start receiving events and/or control commands. */
  async subscribe(channels: { events?: boolean; control?: boolean }): Promise<void> {
    if (!this.sub) this.sub = this.client("sub");
    const sub = this.sub;
    await sub.connect();
    sub.on("message", (channel: string, message: string) => {
      try {
        if (channel === CHANNEL_EVENTS) {
          const e = JSON.parse(message) as RealtimeEvent;
          for (const h of this.eventHandlers) h(e);
        } else if (channel === CHANNEL_CONTROL) {
          const c = JSON.parse(message) as ControlCommand;
          for (const h of this.controlHandlers) h(c);
        }
      } catch (err) {
        this.log.warn({ err, channel }, "invalid redis message");
      }
    });
    const list = [channels.events ? CHANNEL_EVENTS : null, channels.control ? CHANNEL_CONTROL : null].filter((c): c is string => c !== null);
    if (list.length) await sub.subscribe(...list);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub?.quit()]);
  }
}
