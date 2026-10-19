"""Online logistic regression with running standardisation and AdaGrad."""
from __future__ import annotations

import math
from collections import deque

import numpy as np


class RunningScaler:
    def __init__(self, dim: int):
        self.n = 0
        self.mean = np.zeros(dim)
        self.m2 = np.zeros(dim)
        self.inv_sd = np.zeros(dim)   # cached 1 / σ (0 until two samples are seen)

    def update(self, x: np.ndarray) -> None:
        self.n += 1
        d = x - self.mean
        self.mean += d / self.n
        self.m2 += d * (x - self.mean)
        if self.n >= 2:
            self.inv_sd = 1.0 / (np.sqrt(self.m2 / (self.n - 1)) + 1e-9)

    def transform(self, x: np.ndarray) -> np.ndarray:
        z = (x - self.mean) * self.inv_sd
        return np.minimum(np.maximum(z, -5.0), 5.0)

    def to_dict(self) -> dict:
        return {"n": self.n, "mean": self.mean.tolist(), "m2": self.m2.tolist()}

    def load(self, d: dict) -> None:
        if len(d.get("mean", [])) == len(self.mean):
            self.n = int(d["n"])
            self.mean = np.array(d["mean"], dtype=float)
            self.m2 = np.array(d["m2"], dtype=float)
            if self.n >= 2:
                self.inv_sd = 1.0 / (np.sqrt(self.m2 / (self.n - 1)) + 1e-9)


class OnlineLogit:
    def __init__(self, names: list[str], lr: float = 0.03, l2: float = 5e-4):
        self.names = list(names)
        dim = len(names)
        self.lr = lr
        self.l2 = l2
        self.w = np.zeros(dim)
        self.b = 0.0
        self.g2 = np.full(dim, 1e-6)
        self.gb2 = 1e-6
        self.scaler = RunningScaler(dim)
        self.n = 0
        self.recent = deque(maxlen=400)  # (p, y)

    def predict(self, x: np.ndarray) -> float:
        """``x`` must be finite (callers sanitise once, see ``features.pipeline.ml_vector``)."""
        z = float(self.scaler.transform(x) @ self.w + self.b)
        return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))

    def update(self, x: np.ndarray, y: float, weight: float = 1.0) -> float:
        p = self.predict(x)
        self.recent.append((p, y))
        self.scaler.update(x)
        xs = self.scaler.transform(x)
        g = (p - y) * xs * weight + self.l2 * self.w
        gb = (p - y) * weight
        self.g2 += g * g
        self.gb2 += gb * gb
        self.w -= self.lr * g / np.sqrt(self.g2)
        self.b -= self.lr * gb / math.sqrt(self.gb2)
        self.n += 1
        eps = 1e-9
        return -(y * math.log(p + eps) + (1 - y) * math.log(1 - p + eps))

    # ── diagnostics ───────────────────────────────────────────────────────
    def brier(self) -> float:
        if not self.recent:
            return 0.25
        return float(np.mean([(p - y) ** 2 for p, y in self.recent]))

    def accuracy(self) -> float:
        if not self.recent:
            return 0.5
        return float(np.mean([(p > 0.5) == (y > 0.5) for p, y in self.recent]))

    def logloss(self) -> float:
        if not self.recent:
            return math.log(2)
        eps = 1e-9
        return float(np.mean([-(y * math.log(p + eps) + (1 - y) * math.log(1 - p + eps)) for p, y in self.recent]))

    def importance(self) -> list[dict]:
        rows = [{"feature": n, "weight": float(w), "abs": abs(float(w))} for n, w in zip(self.names, self.w)]
        return sorted(rows, key=lambda r: -r["abs"])

    def to_dict(self) -> dict:
        return {"names": self.names, "w": self.w.tolist(), "b": self.b, "g2": self.g2.tolist(), "gb2": self.gb2,
                "n": self.n, "scaler": self.scaler.to_dict(), "recent": list(self.recent)[-200:]}

    def load(self, d: dict) -> None:
        if d.get("names") != self.names:
            return  # feature set changed → start fresh
        self.w = np.array(d["w"], dtype=float)
        self.b = float(d["b"])
        self.g2 = np.array(d["g2"], dtype=float)
        self.gb2 = float(d["gb2"])
        self.n = int(d["n"])
        self.scaler.load(d.get("scaler", {}))
        self.recent.extend(tuple(x) for x in d.get("recent", []))
