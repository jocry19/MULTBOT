"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Same-origin API client: session cookie + CSRF header on every state-changing request. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "x-requested-with": "solarbiter", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const b = body as { error?: string; reasons?: string[] } | null;
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) window.dispatchEvent(new Event("sb:unauthorized"));
    throw new ApiError(res.status, [b?.error ?? res.statusText, ...(b?.reasons ?? [])].join(" — "), body);
  }
  return body as T;
}

/** Polling query hook (pauses while the tab is hidden). */
export function useApi<T>(path: string | null, intervalMs = 5_000): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const my = ++seq.current;
    api<T>(path)
      .then((d) => {
        if (my === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => my === seq.current && setError(e.message))
      .finally(() => my === seq.current && setLoading(false));
  }, [path]);
  useEffect(() => {
    load();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { data, error, reload: load, loading };
}

export interface RealtimeEvent {
  type: string;
  ts: number;
  payload: unknown;
}

/** Realtime events from the worker (via API WebSocket); reconnects with backoff. */
export function useEvents(onEvent: (e: RealtimeEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let delay = 1_000;
    const connect = () => {
      if (stop) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
      ws.onopen = () => {
        setConnected(true);
        delay = 1_000;
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(String(m.data)) as RealtimeEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) setTimeout(connect, (delay = Math.min(delay * 2, 30_000)));
      };
    };
    connect();
    return () => {
      stop = true;
      ws?.close();
    };
  }, []);
  return connected;
}
