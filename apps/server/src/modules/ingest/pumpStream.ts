import type { ComponentStatus } from "@multbot/shared";
import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import { BaseModule } from "../../core/module.js";
import type { Clock } from "../../core/clock.js";
import type { BusEvents } from "../../app/busEvents.js";
import type { MarketEvent } from "../../domain/market.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../pumpfun/constants.js";
import { parseLogs, type ParsedEvent } from "../pumpfun/logParser.js";
import { normalizeEvents } from "../pumpfun/normalize.js";
import type { SolanaWsClient, SubscriptionHandle } from "../solana/wsClient.js";
import type { PoolRegistry } from "./poolRegistry.js";

interface LogsNotification {
  context: { slot: number };
  value: { signature: string; err: unknown; logs: string[] };
}

/** Bounded set of recently processed signatures (a tx touching both programs arrives twice). */
class RecentSet {
  private readonly set = new Set<string>();
  private readonly queue: string[] = [];
  constructor(private readonly max: number) {}
  addIfNew(key: string): boolean {
    if (this.set.has(key)) return false;
    this.set.add(key);
    this.queue.push(key);
    if (this.queue.length > this.max) this.set.delete(this.queue.shift() as string);
    return true;
  }
}

export interface GapRecord {
  start: number;
  end: number;
  reason: string;
}

/**
 * Live ingest of Pump + PumpSwap program logs via logsSubscribe (commitment: confirmed).
 * Failed transactions are ignored (their logs can contain events that were rolled back).
 * Emits normalised events on the bus with availableAt = receive time (+ pool resolution time).
 */
export class PumpStream extends BaseModule {
  private subs: SubscriptionHandle[] = [];
  private readonly seen = new RecentSet(100_000);
  private eventsTimes: number[] = [];
  lastEventAt: number | null = null;
  decodeErrors = 0;
  truncatedLogs = 0;
  private disconnectedSince: number | null = null;
  private readonly gaps: GapRecord[] = [];

  constructor(
    private readonly ws: SolanaWsClient,
    private readonly pools: PoolRegistry,
    private readonly bus: TypedBus<BusEvents>,
    private readonly clock: Clock,
    log: Logger,
    private readonly commitment: "processed" | "confirmed" = "confirmed",
  ) {
    super("ingest", log);
    this.every("gap-watch", 2_000, async () => this.watchGaps());
  }

  protected override async onStart(): Promise<void> {
    for (const program of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]) {
      this.subs.push(
        this.ws.subscribe("logsSubscribe", [{ mentions: [program] }, { commitment: this.commitment }], (r) =>
          this.onLogs(r as LogsNotification),
        ),
      );
    }
    this.ws.start();
  }

  protected override async onStop(): Promise<void> {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    this.ws.stop();
  }

  /** Periods without a connected stream (for data_gaps). */
  takeGaps(): GapRecord[] {
    return this.gaps.splice(0);
  }

  private watchGaps(): void {
    const now = this.clock.now();
    const connected = this.ws.isConnected;
    if (!connected && this.disconnectedSince === null) this.disconnectedSince = now;
    if (connected && this.disconnectedSince !== null) {
      this.gaps.push({ start: this.disconnectedSince, end: now, reason: "websocket disconnected" });
      this.disconnectedSince = null;
    }
  }

  eventsPerMinute(): number {
    const cutoff = this.clock.now() - 60_000;
    this.eventsTimes = this.eventsTimes.filter((t) => t > cutoff);
    return this.eventsTimes.length;
  }

  override componentStatus(): ComponentStatus {
    if (this.state !== "RUNNING") return this.state === "STOPPED" ? "DISABLED" : "DISCONNECTED";
    return this.ws.status();
  }

  override healthDetail(): string {
    return `ws=${this.ws.currentEndpoint ?? "-"} reconnects=${this.ws.reconnects} events/min=${this.eventsPerMinute()} decodeErrors=${this.decodeErrors}`;
  }

  /** Handle one logs notification (public for tests). */
  onLogs(n: LogsNotification): void {
    const receivedAt = this.clock.now();
    const { signature, err, logs } = n.value;
    if (err) return;
    if (!this.seen.addIfNew(signature)) return;
    const parsed = parseLogs(logs);
    if (parsed.truncated) this.truncatedLogs++;
    if (parsed.errors.length > 0) {
      this.decodeErrors += parsed.errors.length;
      this.log.warn({ signature, errors: parsed.errors.slice(0, 3) }, "event decode errors");
    }
    if (parsed.events.length === 0) return;
    this.process(parsed.events, signature, n.context.slot, receivedAt);
  }

  private process(events: ParsedEvent[], signature: string, slot: number, availableAt: number): void {
    // register pools created in this transaction before normalising
    const res = normalizeEvents(events, { signature, slot, availableAt, source: "live", lookupPool: this.pools.lookup });
    for (const e of res.events) {
      if (e.kind === "pool" && e.data.pool) {
        this.pools.add({ pool: e.data.pool, baseMint: e.data.baseMint, quoteMint: e.data.quoteMint, baseDecimals: e.data.baseDecimals });
      }
    }
    if (res.unresolvedPools.length > 0) {
      void Promise.all(res.unresolvedPools.map((p) => this.pools.resolve(p))).then(() => {
        const retry = normalizeEvents(events, {
          signature,
          slot,
          availableAt: Math.max(availableAt, this.clock.now()),
          source: "live",
          lookupPool: this.pools.lookup,
        });
        // emit only the events that could not be resolved the first time
        const pending = new Set(res.unresolvedPools);
        const resolved = retry.events.filter((e) => e.kind === "trade" && e.data.pool !== null && pending.has(e.data.pool));
        if (resolved.length > 0) this.emit(resolved);
      });
    }
    if (res.events.length > 0) this.emit(res.events);
  }

  private emit(events: MarketEvent[]): void {
    const now = this.clock.now();
    for (let i = 0; i < events.length; i++) this.eventsTimes.push(now);
    if (this.eventsTimes.length > 50_000) this.eventsTimes.splice(0, this.eventsTimes.length - 50_000);
    this.lastEventAt = now;
    this.bus.emit("market.events", events);
  }
}
