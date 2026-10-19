"""Multiplicative-weights (Hedge) over strategies, stored in log space as a numpy vector."""
from __future__ import annotations

import numpy as np


class Hedge:
    def __init__(self, keys: list[str], eta: float = 0.06, floor: float = 0.015, decay: float = 0.999):
        self.keys = list(keys)
        self.eta = eta
        self.floor = floor
        self.decay = decay  # forgetting: old evidence fades (memory ≈ 1 / (1 − decay) updates)
        self.logw = np.zeros(len(self.keys))
        self.n = 0

    def update(self, rewards: np.ndarray) -> None:
        """``rewards`` is aligned with ``keys``."""
        lw = self.logw * self.decay + self.eta * np.minimum(np.maximum(rewards, -1.0), 1.0)
        lw -= lw.sum() / len(lw)
        self.logw = np.minimum(np.maximum(lw, -12.0), 12.0)
        self.n += 1

    def weights(self) -> dict[str, float]:
        return dict(zip(self.keys, softmax_floor(self.logw, self.floor).tolist()))

    def to_dict(self) -> dict:
        return {"logw": dict(zip(self.keys, self.logw.tolist())), "n": self.n}

    def load(self, d: dict) -> None:
        saved = d.get("logw") or {}
        for i, k in enumerate(self.keys):
            if k in saved:
                self.logw[i] = float(saved[k])
        self.n = int(d.get("n", 0))


def softmax_floor(logw: np.ndarray, floor: float) -> np.ndarray:
    n = len(logw)
    if not n:
        return logw
    ex = np.exp(logw - logw.max())
    p = ex / ex.sum()
    return (1 - floor * n) * p + floor if floor * n < 1 else np.full(n, 1.0 / n)


def blend_logw(layers: list[tuple[np.ndarray, float]]) -> np.ndarray:
    """Weighted average of several log-weight layers (global / regime / asset)."""
    tot = sum(w for _, w in layers) or 1.0
    out = layers[0][0] * layers[0][1]
    for lw, w in layers[1:]:
        out = out + lw * w
    return out / tot
