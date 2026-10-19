"""Compact, adaptive statistics used by the learning tracker."""
from __future__ import annotations

import math
import random

import numpy as np


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


class EWCorrVec:
    """Many exponentially weighted correlations at once: column i correlates signal i with a shared target.
    Only the columns in ``idx`` are updated (a signal that abstains does not dilute its own statistic).
    State rows: w, mean(s), mean(r), mean(s²), mean(r²), mean(s·r)."""

    def __init__(self, n: int, halflife: float = 400.0):
        self.lam = 0.5 ** (1.0 / halflife)
        self.st = np.zeros((6, n))
        self.n = np.zeros(n, dtype=np.int64)

    w = property(lambda self: self.st[0])
    msr = property(lambda self: self.st[5])
    mss = property(lambda self: self.st[3])

    def add(self, idx: np.ndarray, s: np.ndarray, r: float) -> None:
        full = len(idx) == self.st.shape[1]
        st = self.st if full else self.st[:, idx]
        w = self.lam * st[0] + 1.0
        a = 1.0 / w
        st[0] = w
        st[1] += a * (s - st[1])
        st[2] += a * (r - st[2])
        st[3] += a * (s * s - st[3])
        st[4] += a * (r * r - st[4])
        st[5] += a * (s * r - st[5])
        if full:
            self.n += 1
        else:
            self.st[:, idx] = st
            self.n[idx] += 1

    def corr(self) -> np.ndarray:
        _, ms, mr, mss, mrr, msr = self.st
        vs = mss - ms ** 2
        vr = mrr - mr ** 2
        ok = (self.n >= 10) & (vs > 1e-18) & (vr > 1e-18)
        out = np.zeros(len(ms))
        out[ok] = (msr[ok] - ms[ok] * mr[ok]) / np.sqrt(vs[ok] * vr[ok])
        return np.clip(out, -1.0, 1.0)

    def tstat(self) -> np.ndarray:
        c = self.corr()
        n_eff = np.minimum(self.n, self.st[0])
        ok = (n_eff >= 3) & (np.abs(c) < 1)
        out = np.zeros(len(c))
        out[ok] = c[ok] * np.sqrt((n_eff[ok] - 2) / (1 - c[ok] ** 2))
        return out

    def to_list(self) -> list:
        return [row.tolist() for row in self.st] + [self.n.tolist()]

    def load(self, x: list) -> None:
        if len(x) != 7 or len(x[0]) != self.st.shape[1]:
            return
        self.st = np.array(x[:6], dtype=float)
        self.n = np.array(x[6], dtype=np.int64)


class BetaVec:
    """Decayed Beta posteriors of many hit rates (see ``BetaArm``)."""

    def __init__(self, n: int, decay: float = 0.997):
        self.a = np.ones(n)
        self.b = np.ones(n)
        self.decay = decay

    def update(self, idx: np.ndarray, hit: np.ndarray) -> None:
        self.a[idx] = 1.0 + (self.a[idx] - 1.0) * self.decay + hit
        self.b[idx] = 1.0 + (self.b[idx] - 1.0) * self.decay + (1.0 - hit)

    @property
    def mean(self) -> np.ndarray:
        return self.a / (self.a + self.b)

    @property
    def n(self) -> np.ndarray:
        return self.a + self.b - 2.0

    def prob_above(self, i: int, x: float = 0.5) -> float:
        a, b = self.a[i], self.b[i]
        v = a * b / ((a + b) ** 2 * (a + b + 1))
        if v <= 0:
            return 0.5
        return 0.5 * (1 + math.erf((a / (a + b) - x) / math.sqrt(v) / math.sqrt(2)))

    def ci(self, i: int) -> tuple[float, float]:
        a, b = self.a[i], self.b[i]
        m = a / (a + b)
        sd = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
        return max(0.0, m - 1.96 * sd), min(1.0, m + 1.96 * sd)

    def to_list(self) -> list:
        return [self.a.tolist(), self.b.tolist()]

    def load(self, x: list) -> None:
        if len(x) == 2 and len(x[0]) == len(self.a):
            self.a, self.b = np.array(x[0], dtype=float), np.array(x[1], dtype=float)
