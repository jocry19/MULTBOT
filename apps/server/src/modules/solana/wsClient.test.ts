import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { silentLogger } from "../../core/logger.js";
import { SolanaWsClient } from "./wsClient.js";

const servers: WebSocketServer[] = [];
const clients: SolanaWsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function startServer(onSubscribe?: (socket: WebSocket, id: number, method: string) => void) {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const sockets: WebSocket[] = [];
  let subCounter = 100;
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method.endsWith("Subscribe")) {
        const subId = subCounter++;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: subId }));
        onSubscribe?.(socket, subId, msg.method);
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, sockets, url: `ws://127.0.0.1:${port}` };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        reject(new Error("timeout"));
      }
    }, 10);
  });
}

describe("SolanaWsClient", () => {
  it("delivers notifications and resubscribes after the server drops the connection", async () => {
    const subscribes: number[] = [];
    const srv = await startServer((socket, subId) => {
      subscribes.push(subId);
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: subId, result: { n: subscribes.length } } }));
    });
    const client = new SolanaWsClient([{ name: "local", wsUrl: srv.url }], silentLogger(), { maxBackoffMs: 50 });
    clients.push(client);
    const got: unknown[] = [];
    client.subscribe("logsSubscribe", [{ mentions: ["x"] }], (r) => got.push(r));
    client.start();
    await waitFor(() => got.length === 1);
    expect(client.isConnected).toBe(true);

    srv.sockets[0]?.terminate();
    await waitFor(() => got.length === 2);
    expect(subscribes.length).toBe(2);
    expect(client.reconnects).toBeGreaterThanOrEqual(1);
  });

  it("reconnects when a flowing subscription goes stale", async () => {
    let connections = 0;
    const srv = await startServer();
    srv.wss.on("connection", () => connections++);
    const client = new SolanaWsClient([{ name: "local", wsUrl: srv.url }], silentLogger(), { staleAfterMs: 200, maxBackoffMs: 50 });
    clients.push(client);
    client.subscribe("logsSubscribe", [{ mentions: ["x"] }], () => undefined);
    client.start();
    await waitFor(() => connections >= 2, 8000);
  });

  it("fails over to the next endpoint when the first is unreachable", async () => {
    const srv = await startServer((socket, subId) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: { subscription: subId, result: { slot: 1 } } }));
    });
    const client = new SolanaWsClient(
      [
        { name: "dead", wsUrl: "ws://127.0.0.1:1" },
        { name: "alive", wsUrl: srv.url },
      ],
      silentLogger(),
      { maxBackoffMs: 50 },
    );
    clients.push(client);
    let got = 0;
    client.subscribe("slotSubscribe", [], () => got++);
    client.start();
    await waitFor(() => got > 0, 8000);
    expect(client.currentEndpoint).toBe("alive");
  });

  it("removes one-shot signature subscriptions after the first notification", async () => {
    const srv = await startServer((socket, subId, method) => {
      if (method === "signatureSubscribe") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: subId, result: { value: { err: null } } } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: subId, result: { value: { err: null } } } }));
      }
    });
    const client = new SolanaWsClient([{ name: "local", wsUrl: srv.url }], silentLogger());
    clients.push(client);
    let got = 0;
    client.subscribe("signatureSubscribe", ["sig", { commitment: "confirmed" }], () => got++);
    client.start();
    await waitFor(() => got >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(1);
  });
});
