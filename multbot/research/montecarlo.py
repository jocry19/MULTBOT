"""Monte-Carlo bootstrap of trade returns → distribution of outcomes and risk of ruin at max leverage."""
from __future__ import annotations

import numpy as np


def trade_fractions(trades: list[dict]) -> np.ndarray:
    out = []
    for t in trades:
        base = t.get("eq_entry") or 0.0
        if base <= 0:
            base = t["margin"] / 0.2 if t.get("margin") else 0.0
        if base > 0:
            out.append(t["net"] / base)
    return np.clip(np.array(out, dtype=float), -1.0, 10.0)


def monte_carlo(trades: list[dict], start: float = 100.0, n_paths: int = 3000, n_trades: int = 200,
                ruin_frac: float = 0.05, seed: int = 7, block: int = 1) -> dict:
    f = trade_fractions(trades)
    if len(f) < 5:
        return {"ok": False, "reason": f"zu wenige Trades für Monte Carlo ({len(f)})"}
    rng = np.random.default_rng(seed)
    if block > 1 and len(f) > block:
        starts = rng.integers(0, len(f) - block + 1, size=(n_paths, n_trades // block + 1))
        idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_paths, -1)[:, :n_trades]
    else:
        idx = rng.integers(0, len(f), size=(n_paths, n_trades))
    samples = f[idx]
    paths = start * np.cumprod(1 + samples, axis=1)
    paths = np.maximum(paths, 0.0)
    ruined = (paths <= start * ruin_frac).any(axis=1)
    finals = paths[:, -1]
    peaks = np.maximum.accumulate(paths, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        dds = np.nan_to_num(1 - paths / peaks).max(axis=1)
    steps = np.unique(np.linspace(0, n_trades - 1, 60).astype(int))
    fan = {str(p): [float(np.percentile(paths[:, s], p)) for s in steps] for p in (5, 25, 50, 75, 95)}
    return {
        "ok": True, "n_source_trades": int(len(f)), "n_paths": n_paths, "n_trades": n_trades,
        "mean_trade_frac": float(f.mean()), "std_trade_frac": float(f.std()),
        "p_ruin": float(ruined.mean()), "p_profit": float((finals > start).mean()),
        "p_double": float((finals >= 2 * start).mean()), "p_halve": float((finals <= 0.5 * start).mean()),
        "final_pct": {str(p): float(np.percentile(finals, p)) for p in (1, 5, 25, 50, 75, 95, 99)},
        "median_max_dd": float(np.median(dds)), "p95_max_dd": float(np.percentile(dds, 95)),
        "kelly": _kelly(f), "fan_steps": steps.tolist(), "fan": fan,
    }


def _kelly(f: np.ndarray) -> float | None:
    """Growth-optimal fraction multiplier for the observed return distribution (grid search)."""
    if len(f) < 10 or f.mean() <= 0:
        return 0.0
    best, best_g = 0.0, -1e9
    for k in np.linspace(0.05, 3.0, 60):
        x = 1 + k * f
        if (x <= 0).any():
            break
        g = np.log(x).mean()
        if g > best_g:
            best, best_g = float(k), g
    return best
