"""Historical candles + funding with an incremental on-disk cache."""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

import numpy as np

from ..config import Config
from ..exchange.hyperliquid import HLRest
from ..util import HOUR_MS, INTERVAL_MS, now_ms
from .bars import Bar

log = logging.getLogger("multbot.history")


@dataclass
class History:
    coin: str
    interval: str
    bars: list[Bar] = field(default_factory=list)
    funding_t: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    funding_rate: np.ndarray = field(default_factory=lambda: np.zeros(0))
    premium: np.ndarray = field(default_factory=lambda: np.zeros(0))

    def funding_aligned(self, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Funding rate / premium valid at each bar time (last known hourly print, forward-filled)."""
        if len(self.funding_t) == 0:
            return np.zeros(len(t)), np.zeros(len(t))
        idx = np.searchsorted(self.funding_t, t, side="right") - 1
        valid = idx >= 0
        idx = np.clip(idx, 0, len(self.funding_t) - 1)
        fr = np.where(valid, self.funding_rate[idx], 0.0)
        pr = np.where(valid, self.premium[idx], 0.0)
        return fr, pr


def _cache_file(cfg: Config, coin: str, kind: str):
    return cfg.data_path("history", f"{coin.replace(':', '_')}_{kind}.json")


async def fetch_history(cfg: Config, rest: HLRest, coin: str, interval: str, n_bars: int,
                        use_cache: bool = True, with_funding: bool = True) -> History:
    step = INTERVAL_MS[interval]
    end = now_ms()
    start = end - n_bars * step
    cache = _cache_file(cfg, coin, interval)
    cached: list[dict] = []
    if use_cache and cache.exists():
        try:
            cached = json.loads(cache.read_text())
        except json.JSONDecodeError:
            cached = []
    cached = [c for c in cached if int(c["t"]) >= start]
    # the cache only helps if it reaches back to the requested start; otherwise refetch the whole window
    covers = len(cached) >= 2 and int(cached[0]["t"]) <= start + 2 * step
    fetch_from = int(cached[-2]["t"]) if covers else start
    fresh = await rest.candles(coin, interval, fetch_from, end)
    merged = {int(c["t"]): c for c in cached}
    merged.update({int(c["t"]): c for c in fresh})
    candles = [merged[k] for k in sorted(merged) if k >= start]
    if use_cache:
        cache.write_text(json.dumps(candles))
    # drop the still-forming last candle
    if candles and int(candles[-1]["t"]) + step > end:
        candles = candles[:-1]
    bars = [Bar.from_hl(c) for c in candles]

    if not with_funding:
        return History(coin=coin, interval=interval, bars=bars)
    fcache = _cache_file(cfg, coin, "funding")
    fcached: list[dict] = []
    if use_cache and fcache.exists():
        try:
            fcached = json.loads(fcache.read_text())
        except json.JSONDecodeError:
            fcached = []
    fstart = start - 72 * HOUR_MS
    fcached = [x for x in fcached if int(x["time"]) >= fstart]
    fcovers = bool(fcached) and int(fcached[0]["time"]) <= fstart + 2 * HOUR_MS
    ffrom = int(fcached[-1]["time"]) + 1 if fcovers else fstart
    try:
        ffresh = await rest.funding_history(coin, ffrom)
    except Exception as e:  # funding is optional for research
        log.warning("Funding-Historie %s nicht verfügbar: %s", coin, e)
        ffresh = []
    fmerged = {int(x["time"]): x for x in fcached}
    fmerged.update({int(x["time"]): x for x in ffresh})
    funding = [fmerged[k] for k in sorted(fmerged)]
    if use_cache:
        fcache.write_text(json.dumps(funding))
    return History(
        coin=coin, interval=interval, bars=bars,
        funding_t=np.array([int(x["time"]) for x in funding], dtype=np.int64),
        funding_rate=np.array([float(x["fundingRate"]) for x in funding]),
        premium=np.array([float(x.get("premium", 0.0)) for x in funding]),
    )


async def fetch_all(cfg: Config, rest: HLRest, interval: str | None = None, n_bars: int | None = None,
                    use_cache: bool = True, coins: list[str] | None = None) -> dict[str, History]:
    interval = interval or cfg.signal.interval
    n_bars = n_bars or cfg.learning.history_bars

    async def one(coin):
        h = await fetch_history(cfg, rest, coin, interval, n_bars, use_cache)
        log.info("Historie %-10s %5d Bars (%s), %4d Funding-Prints", coin, len(h.bars), interval, len(h.funding_t))
        return coin, h

    sem = asyncio.Semaphore(6)

    async def limited(coin):
        async with sem:
            return await one(coin)

    results = await asyncio.gather(*(limited(c) for c in (coins or cfg.coins)))
    return dict(results)
