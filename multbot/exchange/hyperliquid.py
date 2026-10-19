"""Read-only Hyperliquid client (info REST endpoint + public WebSocket).

The bot never signs or sends orders – it only consumes public market data.
HIP-3 builder dexes (e.g. ``xyz``) are addressed with ``"dex": "xyz"`` on meta
requests and with prefixed coin names (``xyz:GEV``) everywhere else.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Awaitable, Callable

import httpx

from ..util import INTERVAL_MS, ssl_context

log = logging.getLogger("multbot.hl")

# Approximate request weights from the Hyperliquid docs (1200 weight / minute / IP).
WEIGHTS = {"l2Book": 2, "allMids": 2, "clearinghouseState": 2, "orderStatus": 2,
           "spotClearinghouseState": 2, "exchangeStatus": 2}


class RateLimiter:
    """Token bucket on request weight (stays well below the 1200/min limit)."""

    def __init__(self, per_minute: float = 1000.0):
        self.capacity = per_minute
        self.tokens = per_minute
        self.rate = per_minute / 60.0
        self.ts = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, weight: float) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
                self.ts = now
                if self.tokens >= weight:
                    self.tokens -= weight
                    return
                await asyncio.sleep((weight - self.tokens) / self.rate)

    def charge(self, weight: float) -> None:
        """Book additional weight after a response (item-based weights); later requests wait for it."""
        self.tokens -= weight


class HLRest:
    def __init__(self, base_url: str = "https://api.hyperliquid.xyz", timeout: float = 20.0):
        self.url = base_url.rstrip("/") + "/info"
        self.client = httpx.AsyncClient(timeout=timeout, verify=ssl_context())
        self.limiter = RateLimiter()
        self.requests = 0
        self.errors = 0

    async def close(self) -> None:
        await self.client.aclose()

    async def info(self, payload: dict, retries: int = 4) -> Any:
        weight = WEIGHTS.get(payload.get("type", ""), 20)
        delay = 1.0
        for attempt in range(retries + 1):
            await self.limiter.acquire(weight)
            try:
                self.requests += 1
                r = await self.client.post(self.url, json=payload)
                if r.status_code == 429:
                    raise httpx.HTTPStatusError("rate limited", request=r.request, response=r)
                r.raise_for_status()
                data = r.json()
                # HL charges extra weight per returned items for some info requests
                kind = payload.get("type", "")
                if isinstance(data, list) and kind in ("candleSnapshot", "fundingHistory", "recentTrades"):
                    self.limiter.charge(len(data) / (60 if kind == "candleSnapshot" else 20))
                return data
            except (httpx.HTTPError, json.JSONDecodeError) as e:
                self.errors += 1
                if attempt >= retries:
                    raise
                log.warning("info %s fehlgeschlagen (%s) – neuer Versuch in %.1fs", payload.get("type"), e, delay)
                await asyncio.sleep(delay + random.random() * 0.3)
                delay *= 2

    async def meta_and_ctxs(self, dex: str = "") -> tuple[dict, list]:
        payload: dict = {"type": "metaAndAssetCtxs"}
        if dex:
            payload["dex"] = dex
        meta, ctxs = await self.info(payload)
        return meta, ctxs

    async def l2_book(self, coin: str) -> dict:
        return await self.info({"type": "l2Book", "coin": coin})

    async def recent_trades(self, coin: str) -> list:
        return await self.info({"type": "recentTrades", "coin": coin})

    async def candles(self, coin: str, interval: str, start_ms: int, end_ms: int) -> list[dict]:
        """Candle snapshot with pagination (the API returns at most 5000 candles per call)."""
        step = INTERVAL_MS[interval]
        out: list[dict] = []
        cursor = start_ms
        while cursor < end_ms:
            batch = await self.info({"type": "candleSnapshot",
                                     "req": {"coin": coin, "interval": interval,
                                             "startTime": int(cursor), "endTime": int(end_ms)}})
            if not batch:
                break
            out.extend(batch)
            last_t = int(batch[-1]["t"])
            if last_t + step >= end_ms or len(batch) < 4999:
                break
            cursor = last_t + step
        dedup = {int(c["t"]): c for c in out}
        return [dedup[k] for k in sorted(dedup)]

    async def funding_history(self, coin: str, start_ms: int, end_ms: int | None = None) -> list[dict]:
        out: list[dict] = []
        cursor = start_ms
        for _ in range(50):
            payload = {"type": "fundingHistory", "coin": coin, "startTime": int(cursor)}
            if end_ms:
                payload["endTime"] = int(end_ms)
            batch = await self.info(payload)
            if not batch:
                break
            out.extend(batch)
            if len(batch) < 500:
                break
            cursor = int(batch[-1]["time"]) + 1
        dedup = {int(x["time"]): x for x in out}
        return [dedup[k] for k in sorted(dedup)]


MessageHandler = Callable[[str, Any], Awaitable[None] | None]


class HLWebSocket:
    """Auto-reconnecting public WebSocket with resubscription and keep-alive pings."""

    def __init__(self, url: str, subscriptions: list[dict], on_message: MessageHandler):
        self.url = url
        self.subscriptions = subscriptions
        self.on_message = on_message
        self.connected = False
        self.messages = 0
        self.reconnects = 0
        self.last_msg_ms = 0
        self._stop = asyncio.Event()
        self._ws = None

    def stop(self) -> None:
        self._stop.set()

    @staticmethod
    def _key(sub: dict) -> str:
        return json.dumps(sub, sort_keys=True)

    async def update_subscriptions(self, subs: list[dict]) -> tuple[int, int]:
        """Change subscriptions at runtime (sends only the difference). Returns (added, removed)."""
        old = {self._key(s): s for s in self.subscriptions}
        new = {self._key(s): s for s in subs}
        added = [new[k] for k in new.keys() - old.keys()]
        removed = [old[k] for k in old.keys() - new.keys()]
        self.subscriptions = list(subs)
        ws = self._ws
        if ws is not None and self.connected:
            try:
                for s in removed:
                    await ws.send(json.dumps({"method": "unsubscribe", "subscription": s}))
                for s in added:
                    await ws.send(json.dumps({"method": "subscribe", "subscription": s}))
            except Exception as e:  # noqa: BLE001 – reconnect will resubscribe everything
                log.debug("Abo-Änderung fehlgeschlagen: %s", e)
        return len(added), len(removed)

    async def run(self) -> None:
        import websockets

        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(self.url, ssl=ssl_context(), open_timeout=15,
                                              ping_interval=None, max_size=2**23) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 1.0
                    for sub in self.subscriptions:
                        await ws.send(json.dumps({"method": "subscribe", "subscription": sub}))
                    log.info("WebSocket verbunden (%d Abos)", len(self.subscriptions))
                    pinger = asyncio.create_task(self._ping(ws))
                    try:
                        async for raw in ws:
                            if self._stop.is_set():
                                break
                            self.messages += 1
                            self.last_msg_ms = int(time.time() * 1000)
                            try:
                                msg = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            channel = msg.get("channel", "")
                            if channel in ("subscriptionResponse", "pong"):
                                continue
                            res = self.on_message(channel, msg.get("data"))
                            if asyncio.iscoroutine(res):
                                await res
                    finally:
                        pinger.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # network errors → reconnect
                log.warning("WebSocket getrennt: %s – reconnect in %.0fs", e, backoff)
            self.connected = False
            self._ws = None
            if self._stop.is_set():
                break
            self.reconnects += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _ping(self, ws) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                await ws.send(json.dumps({"method": "ping"}))
            except Exception:
                return
