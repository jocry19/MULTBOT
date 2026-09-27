import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActivityDto, StreamMessage, SystemHealthDto } from "@multbot/shared";

/**
 * Live dashboard stream (activity feed, health, cache invalidation). Reconnects with backoff.
 */
export function useLiveStream(): { connected: boolean; health: SystemHealthDto | null; activity: ActivityDto[] } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<SystemHealthDto | null>(null);
  const [activity, setActivity] = useState<ActivityDto[]>([]);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/stream`);
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry.current++;
        timer = window.setTimeout(connect, Math.min(15_000, 500 * 2 ** retry.current));
      };
      ws.onmessage = (e) => {
        let m: StreamMessage;
        try {
          m = JSON.parse(e.data as string) as StreamMessage;
        } catch {
          return;
        }
        if (m.type === "activity") setActivity((prev) => [m.payload, ...prev].slice(0, 300));
        else if (m.type === "health") setHealth(m.payload);
        else if (m.type === "invalidate") for (const k of m.payload.keys) void qc.invalidateQueries({ queryKey: [k] });
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);

  return { connected, health, activity };
}
