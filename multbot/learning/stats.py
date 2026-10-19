"""Compact, adaptive statistics used by the learning tracker."""
from __future__ import annotations

import math
import random


class EWCorr:
    """Exponentially weighted correlation (information coefficient) between a signal and a return."""

    __slots__ = ("lam", "w", "ms", "mr", "mss", "mrr", "msr", "n")

    def __init__(self, halflife: float = 400.0):
        self.lam = 0.5 ** (1.0 / halflife)
        self.w = self.ms = self.mr = self.mss = self.mrr = self.msr = 0.0
        self.n = 0

    def add(self, s: float, r: float) -> None:
        lam = self.lam
        self.w = lam * self.w + 1.0
        a = 1.0 / self.w
        self.ms += a * (s - self.ms)
        self.mr += a * (r - self.mr)
        self.mss += a * (s * s - self.mss)
        self.mrr += a * (r * r - self.mrr)
        self.msr += a * (s * r - self.msr)
        self.n += 1

    @property
    def corr(self) -> float:
        vs = self.mss - self.ms ** 2
        vr = self.mrr - self.mr ** 2
        if self.n < 10 or vs <= 1e-18 or vr <= 1e-18:
            return 0.0
        return max(-1.0, min(1.0, (self.msr - self.ms * self.mr) / math.sqrt(vs * vr)))

    @property
    def tstat(self) -> float:
        c = self.corr
        n_eff = min(self.n, self.w)
        if n_eff < 3 or abs(c) >= 1:
            return 0.0
        return c * math.sqrt((n_eff - 2) / (1 - c * c))

    def to_list(self) -> list:
        return [self.w, self.ms, self.mr, self.mss, self.mrr, self.msr, self.n]

    def load(self, x: list) -> None:
        self.w, self.ms, self.mr, self.mss, self.mrr, self.msr = (float(v) for v in x[:6])
        self.n = int(x[6])


class EWMean:
    """Exponentially weighted mean with its effective sample weight."""

    __slots__ = ("lam", "w", "m", "n")

    def __init__(self, halflife: float = 20000.0):
        self.lam = 0.5 ** (1.0 / halflife)
        self.w = self.m = 0.0
        self.n = 0

    def add(self, x: float) -> None:
        self.w = self.lam * self.w + 1.0
        self.m += (x - self.m) / self.w
        self.n += 1

    def to_list(self) -> list:
        return [self.w, self.m, self.n]

    def load(self, x: list) -> None:
        self.w, self.m, self.n = float(x[0]), float(x[1]), int(x[2])


class BetaArm:
    """Decayed Beta posterior of a strategy's directional hit rate (Thompson-style)."""

    __slots__ = ("a", "b", "decay")

    def __init__(self, decay: float = 0.997):
        self.a = 1.0
        self.b = 1.0
        self.decay = decay

    def update(self, hit: bool) -> None:
        self.a = 1.0 + (self.a - 1.0) * self.decay + (1.0 if hit else 0.0)
        self.b = 1.0 + (self.b - 1.0) * self.decay + (0.0 if hit else 1.0)

    @property
    def mean(self) -> float:
        return self.a / (self.a + self.b)

    @property
    def n(self) -> float:
        return self.a + self.b - 2.0

    def sample(self) -> float:
        return random.betavariate(self.a, self.b)

    def prob_above(self, x: float = 0.5) -> float:
        """P(p > x) via normal approximation of the Beta posterior."""
        a, b = self.a, self.b
        m = a / (a + b)
        v = a * b / ((a + b) ** 2 * (a + b + 1))
        if v <= 0:
            return 0.5
        z = (m - x) / math.sqrt(v)
        return 0.5 * (1 + math.erf(z / math.sqrt(2)))

    def ci(self) -> tuple[float, float]:
        a, b = self.a, self.b
        m = a / (a + b)
        sd = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
        return max(0.0, m - 1.96 * sd), min(1.0, m + 1.96 * sd)

    def to_list(self) -> list:
        return [self.a, self.b]

    def load(self, x: list) -> None:
        self.a, self.b = float(x[0]), float(x[1])


class Calibration:
    """Reliability diagram bins for probabilistic forecasts."""

    def __init__(self, bins: int = 10):
        self.bins = bins
        self.cnt = [0] * bins
        self.sum_p = [0.0] * bins
        self.sum_y = [0.0] * bins

    def add(self, p: float, y: float) -> None:
        i = min(self.bins - 1, max(0, int(p * self.bins)))
        self.cnt[i] += 1
        self.sum_p[i] += p
        self.sum_y[i] += y

    def table(self) -> list[dict]:
        return [{"bin": i / self.bins, "n": c, "pred": (sp / c if c else None), "obs": (sy / c if c else None)}
                for i, (c, sp, sy) in enumerate(zip(self.cnt, self.sum_p, self.sum_y))]

    def to_dict(self) -> dict:
        return {"cnt": self.cnt, "sum_p": self.sum_p, "sum_y": self.sum_y}

    def load(self, d: dict) -> None:
        if len(d.get("cnt", [])) == self.bins:
            self.cnt, self.sum_p, self.sum_y = list(d["cnt"]), list(d["sum_p"]), list(d["sum_y"])
