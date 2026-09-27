import pino from "pino";
import { describe, expect, it } from "vitest";
import type { NotificationDto } from "@solarbiter/shared";
import { secrets } from "@solarbiter/shared/node";
import { NotificationService } from "./service.js";

describe("NotificationService", () => {
  it("stores, publishes, dedupes, scrubs secrets and calls the webhook for errors", async () => {
    const stored: NotificationDto[] = [];
    const published: NotificationDto[] = [];
    const hooks: string[] = [];
    let t = 0;
    secrets.register("super-secret-api-key-123");
    const svc = new NotificationService(
      {
        async store(n) {
          const dto = { ...n, id: stored.length + 1, ts: new Date(t).toISOString(), read: false, data: n.data ?? null };
          stored.push(dto);
          return dto;
        },
        publish: (n) => void published.push(n),
      },
      pino({ level: "silent" }),
      { webhookUrl: "https://hook.test", now: () => t, fetchImpl: (async (_u: string, init?: RequestInit) => { hooks.push(String(init?.body)); return new Response("ok"); }) as unknown as typeof fetch },
    );
    await svc.notify({ type: "RPC_OUTAGE", severity: "error", title: "RPC down", message: "key super-secret-api-key-123 rejected", data: { url: "https://x/?api-key=super-secret-api-key-123" } });
    await svc.notify({ type: "RPC_OUTAGE", severity: "error", title: "RPC down", message: "key super-secret-api-key-123 rejected" });
    await new Promise((r) => setTimeout(r, 10));
    expect(stored).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("super-secret-api-key-123");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).not.toContain("super-secret-api-key-123");
    t += 61_000;
    await svc.notify({ type: "RPC_OUTAGE", severity: "info", title: "RPC down", message: "key super-secret-api-key-123 rejected" });
    expect(stored).toHaveLength(2);
  });
});
