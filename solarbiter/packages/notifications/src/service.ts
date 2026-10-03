import { toJsonSafe, type NotificationDto, type NotificationType, type Severity } from "@solarbiter/shared";
import { secrets } from "@solarbiter/shared/node";
import type { Logger } from "pino";

export interface NotificationInput {
  type: NotificationType;
  severity: Severity;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
}

/** Persistence + fan-out ports (database row, realtime event). */
export interface NotificationSinks {
  store(n: NotificationInput): Promise<NotificationDto>;
  publish(n: NotificationDto): void | Promise<void>;
  markWebhook?(id: number, delivered: boolean): Promise<void>;
}

/**
 * Notifications: stored, pushed to the UI, and optionally sent to a webhook (errors and above,
 * rate-limited). Text is scrubbed of every registered secret before it leaves the process.
 */
export class NotificationService {
  private readonly recent = new Map<string, number>();
  private webhookSent: number[] = [];

  constructor(
    private readonly sinks: NotificationSinks,
    private readonly log: Logger,
    private readonly opts: { webhookUrl?: string; dedupeMs?: number; webhookPerMinute?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async notify(n: NotificationInput): Promise<NotificationDto | null> {
    const key = `${n.type}|${n.title}|${n.message}`;
    const t = this.now();
    const last = this.recent.get(key);
    if (last !== undefined && t - last < (this.opts.dedupeMs ?? 60_000)) return null;
    this.recent.set(key, t);
    if (this.recent.size > 1_000) for (const [k, v] of this.recent) if (t - v > 3_600_000) this.recent.delete(k);

    const clean: NotificationInput = {
      ...n,
      title: secrets.scrub(n.title),
      message: secrets.scrub(n.message),
      data: n.data ? (JSON.parse(secrets.scrub(JSON.stringify(toJsonSafe(n.data)))) as Record<string, unknown>) : null,
    };
    const dto = await this.sinks.store(clean);
    await this.sinks.publish(dto);
    if (this.opts.webhookUrl && (n.severity === "error" || n.severity === "critical" || n.type === "TRADE_EXECUTED" || n.type === "EMERGENCY_STOP")) {
      void this.webhook(dto);
    }
    return dto;
  }

  private async webhook(n: NotificationDto): Promise<void> {
    const t = this.now();
    this.webhookSent = this.webhookSent.filter((x) => t - x < 60_000);
    if (this.webhookSent.length >= (this.opts.webhookPerMinute ?? 10)) return;
    this.webhookSent.push(t);
    let ok = false;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.webhookUrl as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[SOLARBITER] ${n.severity.toUpperCase()} ${n.title}: ${n.message}`, notification: n }),
        signal: AbortSignal.timeout(5_000),
      });
      ok = res.ok;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "notification webhook failed");
    }
    await this.sinks.markWebhook?.(n.id, ok).catch(() => undefined);
  }
}
