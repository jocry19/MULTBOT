import { Worker } from "node:worker_threads";
import type { ComponentStatus, Settings } from "@multbot/shared";
import type { Logger } from "pino";
import { BaseModule, type ModuleHealth } from "../../core/module.js";
import { backoffDelay } from "../../core/retry.js";
import type { ActivityLog } from "../activity/activityLog.js";
import type { FromWorker, ResearchMethod, ToWorker } from "./protocol.js";

/**
 * Supervises the research worker thread: starts it, restarts it after crashes (bounded backoff),
 * forwards activity/health, and offers request/response calls (discovery, backtests, analogues).
 */
export class ResearchHost extends BaseModule {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private workerModules: ModuleHealth[] = [];
  private restarts = 0;
  private stopping = false;
  private ready = false;
  private readonly strategyListeners = new Set<() => void>();

  constructor(
    private readonly settings: () => Settings,
    private readonly activity: ActivityLog,
    log: Logger,
  ) {
    super("research-host", log);
  }

  onStrategiesChanged(fn: () => void): void {
    this.strategyListeners.add(fn);
  }

  protected override async onStart(): Promise<void> {
    this.stopping = false;
    this.spawn();
  }

  protected override async onStop(): Promise<void> {
    this.stopping = true;
    const w = this.worker;
    if (!w) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void w.terminate().then(() => resolve());
      }, 15_000);
      w.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.post({ type: "stop" });
    });
    this.worker = null;
  }

  private spawn(): void {
    const url = new URL("./worker.js", import.meta.url);
    const w = new Worker(url, { workerData: { settings: this.settings() } });
    this.worker = w;
    this.ready = false;
    w.on("message", (m: FromWorker) => this.onMessage(m));
    w.on("error", (err) => {
      this.lastError = err.message;
      this.log.error({ err }, "research worker error");
    });
    w.on("exit", (code) => {
      this.worker = null;
      this.ready = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("research worker exited"));
        this.pending.delete(id);
      }
      if (this.stopping) return;
      this.restarts++;
      const delay = backoffDelay(this.restarts, 2_000, 120_000);
      this.activity.error("system", `Research worker exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => {
        if (!this.stopping) this.spawn();
      }, delay).unref();
    });
  }

  private post(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  pushSettings(s: Settings): void {
    this.post({ type: "settings", settings: s });
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case "ready":
        this.ready = true;
        this.restarts = 0;
        break;
      case "activity":
        this.activity.add(m.level, m.category, m.message, m.data);
        break;
      case "strategies-changed":
        for (const l of this.strategyListeners) l();
        break;
      case "health":
        this.workerModules = m.modules;
        break;
      case "response": {
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? "research request failed"));
        break;
      }
      case "stopped":
        break;
    }
  }

  request<T>(method: ResearchMethod, params: Record<string, unknown> = {}, timeoutMs = 30 * 60_000): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("research worker not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`research request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.post({ type: "request", id, method, params });
    });
  }

  get workerHealth(): ModuleHealth[] {
    return this.workerModules;
  }

  override componentStatus(): ComponentStatus {
    if (!this.worker) return "DISCONNECTED";
    return this.ready ? "CONNECTED" : "DEGRADED";
  }

  override healthDetail(): string {
    return `worker=${this.worker ? (this.ready ? "ready" : "starting") : "down"} restarts=${this.restarts}`;
  }
}
