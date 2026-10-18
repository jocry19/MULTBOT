"""Small shared helpers: time, sessions, numeric safety, logging."""
from __future__ import annotations

import logging
import math
import os
import ssl
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

INTERVAL_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}
HOUR_MS = 3_600_000
DAY_MS = 86_400_000


def now_ms() -> int:
    return int(time.time() * 1000)


def fmt_ts(ms: int | float | None, with_date: bool = True) -> str:
    if not ms:
        return "-"
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S" if with_date else "%H:%M:%S")


def floor_interval(ms: int, interval_ms: int) -> int:
    return ms - (ms % interval_ms)


def us_session(ms: int) -> str:
    """US equity session for a timestamp (exchange holidays ignored).

    REGULAR 09:30-16:00 ET, PRE 04:00-09:30, POST 16:00-20:00, otherwise CLOSED.
    """
    dt = datetime.fromtimestamp(ms / 1000, tz=ET)
    if dt.weekday() >= 5:
        return "CLOSED"
    minutes = dt.hour * 60 + dt.minute
    if 570 <= minutes < 960:
        return "REGULAR"
    if 240 <= minutes < 570:
        return "PRE"
    if 960 <= minutes < 1200:
        return "POST"
    return "CLOSED"


def finite(x, default: float = 0.0) -> float:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def floor_to_decimals(x: float, decimals: int) -> float:
    f = 10 ** max(decimals, 0)
    return math.floor(x * f + 1e-9) / f


def ssl_context() -> ssl.SSLContext:
    """Default SSL context that also honours SSL_CERT_FILE / REQUESTS_CA_BUNDLE (corporate proxies)."""
    for var in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        path = os.environ.get(var)
        if path and os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
