"""Multiplicative-weights (Hedge) over strategies, stored in log space."""
from __future__ import annotations

import math


class Hedge:
    def __init__(self, keys: list[str], eta: float = 0.06, floor: float = 0.015, decay: float = 0.999):
        self.keys = list(keys)
        self.eta = eta
        self.floor = floor
        self.decay = decay  # forgetting: old evidence fades (memory ≈ 1 / (1 − decay) updates)
        self.logw = {k: 0.0 for k in self.keys}
        self.n = 0

    def update(self, rewards: dict[str, float]) -> None:
        for k in self.logw:
            self.logw[k] *= self.decay
        for k, r in rewards.items():
            if k in self.logw:
                self.logw[k] += self.eta * max(-1.0, min(1.0, r))
        m = sum(self.logw.values()) / max(len(self.logw), 1)
        for k in self.logw:
            self.logw[k] = max(-12.0, min(12.0, self.logw[k] - m))
        self.n += 1

    def weights(self) -> dict[str, float]:
        return softmax_floor(self.logw, self.floor)

    def to_dict(self) -> dict:
        return {"logw": self.logw, "n": self.n}

    def load(self, d: dict) -> None:
        for k, v in (d.get("logw") or {}).items():
            if k in self.logw:
                self.logw[k] = float(v)
        self.n = int(d.get("n", 0))


def softmax_floor(logw: dict[str, float], floor: float) -> dict[str, float]:
    if not logw:
        return {}
    mx = max(logw.values())
    ex = {k: math.exp(v - mx) for k, v in logw.items()}
    s = sum(ex.values())
    n = len(ex)
    return {k: (1 - floor * n) * v / s + floor if floor * n < 1 else 1.0 / n for k, v in ex.items()}


def blend_logw(layers: list[tuple[dict[str, float], float]]) -> dict[str, float]:
    """Weighted average of several log-weight layers (global / regime / asset)."""
    keys = layers[0][0].keys()
    tot = sum(w for _, w in layers) or 1.0
    return {k: sum(l.get(k, 0.0) * w for l, w in layers) / tot for k in keys}
