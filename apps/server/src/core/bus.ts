import type { Logger } from "pino";

type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * In-process typed event bus. Publishers never block on or fail because of subscribers:
 * handler errors (sync or async) are caught and logged.
 */
export class TypedBus<Events extends { [K in keyof Events]: unknown }> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();
  private readonly counts = new Map<keyof Events, number>();

  constructor(private readonly log?: Logger) {}

  on<K extends keyof Events>(topic: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(topic: K, payload: Events[K]): void {
    this.counts.set(topic, (this.counts.get(topic) ?? 0) + 1);
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const h of set) {
      try {
        const r = (h as Handler<Events[K]>)(payload);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => this.log?.error({ err, topic }, "bus handler failed"));
        }
      } catch (err) {
        this.log?.error({ err, topic }, "bus handler failed");
      }
    }
  }

  emitted(topic: keyof Events): number {
    return this.counts.get(topic) ?? 0;
  }
}
