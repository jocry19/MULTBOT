import type { ActivityDto, ActivityLevel } from "@multbot/shared";
import type { Logger } from "pino";
import type { TypedBus } from "../../core/bus.js";
import type { Database } from "../../db/database.js";
import type { BusEvents } from "../../app/busEvents.js";

/**
 * The bot activity feed ("15:31:02 Detected abnormal buyer acceleration …").
 * Entries are pushed to the dashboard immediately and persisted in batches.
 */
export class ActivityLog {
  private buffer: { ts: Date; level: ActivityLevel; category: string; message: string; data: unknown }[] = [];
  private seq = 0;

  constructor(
    private readonly db: Database | null,
    private readonly bus: TypedBus<BusEvents>,
    private readonly log: Logger,
  ) {}

  add(level: ActivityLevel, category: string, message: string, data?: Record<string, unknown>): void {
    const ts = new Date();
    const dto: ActivityDto = { id: --this.seq, ts: ts.toISOString(), level, category, message, data: data ?? null };
    this.buffer.push({ ts, level, category, message, data: data ?? null });
    if (this.buffer.length > 5000) this.buffer.splice(0, this.buffer.length - 5000);
    this.bus.emit("activity", dto);
    if (level === "error") this.log.error({ category, data }, message);
    else if (level === "warning") this.log.warn({ category, data }, message);
    else this.log.debug({ category }, message);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.add("info", category, message, data);
  }
  success(category: string, message: string, data?: Record<string, unknown>): void {
    this.add("success", category, message, data);
  }
  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.add("warning", category, message, data);
  }
  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.add("error", category, message, data);
  }

  async flush(): Promise<void> {
    if (!this.db || this.buffer.length === 0) return;
    const rows = this.buffer.splice(0);
    try {
      await this.db.insertMany(
        "bot_activity",
        ["ts", "level", "category", "message", "data"],
        rows.map((r) => [r.ts, r.level, r.category, r.message, r.data === null ? null : JSON.stringify(r.data)]),
      );
    } catch (err) {
      // keep the entries for the next attempt (bounded)
      this.buffer.unshift(...rows.slice(-2000));
      throw err;
    }
  }
}
