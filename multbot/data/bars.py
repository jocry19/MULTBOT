"""OHLCV bar storage."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FIELDS = ("t", "o", "h", "l", "c", "v", "n")


@dataclass
class Bar:
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0
    n: int = 0

    @classmethod
    def from_hl(cls, c: dict) -> "Bar":
        return cls(int(c["t"]), float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"]),
                   float(c.get("v", 0.0)), int(c.get("n", 0)))

    def to_list(self) -> list:
        return [self.t, self.o, self.h, self.l, self.c, self.v, self.n]


class BarSeries:
    """Append/upsert bar buffer with cheap numpy export."""

    def __init__(self, maxlen: int = 5000):
        self.maxlen = maxlen
        self.cols: dict[str, list] = {k: [] for k in FIELDS}

    def __len__(self) -> int:
        return len(self.cols["t"])

    def upsert(self, bar: Bar) -> bool:
        """Insert or replace; returns True if a new bar was appended."""
        t = self.cols["t"]
        if t and bar.t == t[-1]:
            for k, v in zip(FIELDS, bar.to_list()):
                self.cols[k][-1] = v
            return False
        if t and bar.t < t[-1]:
            # late update for an older bar: replace in place if present
            try:
                i = t.index(bar.t)
            except ValueError:
                return False
            for k, v in zip(FIELDS, bar.to_list()):
                self.cols[k][i] = v
            return False
        for k, v in zip(FIELDS, bar.to_list()):
            self.cols[k].append(v)
        if len(t) > self.maxlen:
            drop = len(t) - self.maxlen
            for k in FIELDS:
                del self.cols[k][:drop]
        return True

    def extend(self, bars) -> None:
        for b in bars:
            self.upsert(b)

    def merge(self, bars, prefer_existing: bool = True) -> None:
        """Merge (older) bars into the series, e.g. history fetched after live bars already arrived."""
        new = {b.t: b.to_list() for b in bars}
        have = {t: [self.cols[k][i] for k in FIELDS] for i, t in enumerate(self.cols["t"])}
        rows = {**new, **have} if prefer_existing else {**have, **new}
        ordered = [rows[t] for t in sorted(rows)][-self.maxlen:]
        self.cols = {k: [r[j] for r in ordered] for j, k in enumerate(FIELDS)}

    def last(self) -> Bar | None:
        if not self.cols["t"]:
            return None
        return Bar(*[self.cols[k][-1] for k in FIELDS])

    def arrays(self, last: int | None = None) -> dict[str, np.ndarray]:
        sl = slice(-last, None) if last else slice(None)
        out = {k: np.asarray(self.cols[k][sl], dtype=float) for k in FIELDS}
        out["t"] = out["t"].astype(np.int64)
        return out


def arrays_from_bars(bars: list[Bar]) -> dict[str, np.ndarray]:
    s = BarSeries(maxlen=max(len(bars), 1))
    s.extend(bars)
    return s.arrays()
