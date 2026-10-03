import type { ComponentStatus, EngineState } from "@multbot/shared";
import type { Logger } from "pino";
import { errorMessage } from "./errors.js";

export interface ModuleHealth {
  name: string;
  state: EngineState;
  status: ComponentStatus;
  detail?: string;
  lastError?: string | null;
}

export interface Module {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ModuleHealth;
}

/**
 * Periodic job that never overlaps with itself, backs off after failures and can be stopped.
 * Errors are reported, never thrown into the event loop.
 */
export class PeriodicTask {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private failures = 0;
  lastError: string | null = null;
  lastRunAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
    private readonly log: Logger,
    private readonly opts: { runImmediately?: boolean; maxBackoffMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.opts.runImmediately ? 0 : this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run now (if not already running). Resolves when the run completes. */
  async runNow(): Promise<void> {
    if (this.running) return;
    await this.tick(false);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(true), delay);
    this.timer.unref?.();
  }

  private async tick(reschedule: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.fn();
      this.failures = 0;
      this.lastError = null;
    } catch (err) {
      this.failures++;
      this.lastError = errorMessage(err);
      this.log.error({ err, task: this.name, failures: this.failures }, "periodic task failed");
      this.opts.onError?.(err);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      if (reschedule) {
        const backoff = this.failures > 0
          ? Math.min(this.intervalMs * 2 ** Math.min(this.failures, 6), this.opts.maxBackoffMs ?? 5 * 60_000)
          : this.intervalMs;
        this.schedule(backoff);
      }
    }
  }
}

export abstract class BaseModule implements Module {
  protected state: EngineState = "STOPPED";
  protected lastError: string | null = null;
  private readonly tasks: PeriodicTask[] = [];

  constructor(
    readonly name: string,
    protected readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.state = "STARTING";
    try {
      await this.onStart();
      for (const t of this.tasks) t.start();
      this.state = "RUNNING";
    } catch (err) {
      this.state = "ERROR";
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const t of this.tasks) t.stop();
    await this.onStop();
    this.state = "STOPPED";
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  /** Register a periodic job; it starts with the module. */
  protected every(name: string, intervalMs: number, fn: () => Promise<void>, runImmediately = false): PeriodicTask {
    const task = new PeriodicTask(`${this.name}.${name}`, intervalMs, fn, this.log, {
      runImmediately,
      onError: (err) => {
        this.lastError = errorMessage(err);
      },
    });
    this.tasks.push(task);
    if (this.state === "RUNNING") task.start();
    return task;
  }

  protected componentStatus(): ComponentStatus {
    if (this.state === "RUNNING") return this.tasks.some((t) => t.lastError) ? "DEGRADED" : "CONNECTED";
    if (this.state === "ERROR") return "DISCONNECTED";
    return "UNKNOWN";
  }

  protected healthDetail(): string | undefined {
    return undefined;
  }

  health(): ModuleHealth {
    const detail = this.healthDetail();
    return {
      name: this.name,
      state: this.state,
      status: this.componentStatus(),
      ...(detail ? { detail } : {}),
      lastError: this.lastError,
    };
  }
}

/** Starts modules in registration order, stops them in reverse order. */
export class ModuleRegistry {
  private readonly modules: Module[] = [];

  constructor(private readonly log: Logger) {}

  register<M extends Module>(module: M): M {
    this.modules.push(module);
    return module;
  }

  get(name: string): Module | undefined {
    return this.modules.find((m) => m.name === name);
  }

  async startAll(): Promise<void> {
    for (const m of this.modules) {
      this.log.info({ module: m.name }, "starting module");
      await m.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const m of [...this.modules].reverse()) {
      try {
        await m.stop();
      } catch (err) {
        this.log.error({ err, module: m.name }, "module stop failed");
      }
    }
  }

  health(): ModuleHealth[] {
    return this.modules.map((m) => m.health());
  }
}
