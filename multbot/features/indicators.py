"""Vectorised technical indicators (numpy only). All functions return arrays aligned with the input."""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

NAN = np.nan


def ema(x: np.ndarray, span: int) -> np.ndarray:
    a = 2.0 / (span + 1.0)
    b = 1.0 - a
    vals = np.nan_to_num(np.asarray(x, dtype=float)).tolist()
    if not vals:
        return np.empty(0)
    acc = vals[0]
    res = [0.0] * len(vals)
    for i, v in enumerate(vals):
        acc = a * v + b * acc
        res[i] = acc
    return np.array(res)


def wilder(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder smoothing (RMA)."""
    return ema(x, 2 * n - 1)


def sma(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    if len(x) < n:
        return out
    c = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def rolling_std(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    if len(x) < n:
        return out
    c1 = np.cumsum(np.insert(x, 0, 0.0))
    c2 = np.cumsum(np.insert(x * x, 0, 0.0))
    s1 = c1[n:] - c1[:-n]
    s2 = c2[n:] - c2[:-n]
    var = np.maximum(s2 / n - (s1 / n) ** 2, 0.0) * n / max(n - 1, 1)
    out[n - 1:] = np.sqrt(var)
    return out


def rolling_max(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    if len(x) >= n:
        out[n - 1:] = sliding_window_view(x, n).max(axis=1)
    return out


def rolling_min(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    if len(x) >= n:
        out[n - 1:] = sliding_window_view(x, n).min(axis=1)
    return out


def rolling_sum(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), NAN)
    if len(x) >= n:
        c = np.cumsum(np.insert(x, 0, 0.0))
        out[n - 1:] = c[n:] - c[:-n]
    return out


def rolling_mean(x: np.ndarray, n: int) -> np.ndarray:
    return sma(x, n)


def zscore(x: np.ndarray, n: int) -> np.ndarray:
    m = sma(x, n)
    s = rolling_std(x, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(s > 0, (x - m) / s, 0.0)


def rolling_rank(x: np.ndarray, n: int) -> np.ndarray:
    """Percentile rank (0..1) of the latest value within the trailing window."""
    out = np.full(len(x), NAN)
    if len(x) >= n:
        w = sliding_window_view(x, n)
        out[n - 1:] = (w < w[:, -1:]).sum(axis=1) / (n - 1)
    return out


def shift(x: np.ndarray, k: int = 1, fill=NAN) -> np.ndarray:
    out = np.full(len(x), fill, dtype=float)
    if k > 0:
        out[k:] = x[:-k]
    elif k < 0:
        out[:k] = x[-k:]
    else:
        out[:] = x
    return out


def true_range(h, l, c) -> np.ndarray:
    pc = shift(c, 1)
    pc[0] = c[0]
    return np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))


def atr(h, l, c, n: int = 14) -> np.ndarray:
    return wilder(true_range(h, l, c), n)


def rsi(c: np.ndarray, n: int = 14) -> np.ndarray:
    d = np.diff(c, prepend=c[0])
    up = wilder(np.maximum(d, 0), n)
    dn = wilder(np.maximum(-d, 0), n)
    with np.errstate(invalid="ignore", divide="ignore"):
        rs = np.where(dn > 0, up / dn, np.where(up > 0, 100.0, 1.0))
    return 100 - 100 / (1 + rs)


def macd(c: np.ndarray, fast=12, slow=26, sig=9):
    m = ema(c, fast) - ema(c, slow)
    s = ema(m, sig)
    return m, s, m - s


def bollinger(c: np.ndarray, n=20, k=2.0):
    mid = sma(c, n)
    sd = rolling_std(c, n)
    return mid, mid + k * sd, mid - k * sd, sd


def keltner(h, l, c, n=20, k=1.5):
    mid = ema(c, n)
    a = atr(h, l, c, n)
    return mid, mid + k * a, mid - k * a


def adx(h, l, c, n: int = 14):
    up = np.diff(h, prepend=h[0])
    dn = -np.diff(l, prepend=l[0])
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = wilder(true_range(h, l, c), n)
    with np.errstate(invalid="ignore", divide="ignore"):
        pdi = 100 * np.where(tr > 0, wilder(plus_dm, n) / tr, 0.0)
        mdi = 100 * np.where(tr > 0, wilder(minus_dm, n) / tr, 0.0)
        dx = 100 * np.where(pdi + mdi > 0, np.abs(pdi - mdi) / (pdi + mdi), 0.0)
    return wilder(dx, n), pdi, mdi


def stochastic(h, l, c, n=14, d=3):
    hh = rolling_max(h, n)
    ll = rolling_min(l, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        k = np.where(hh - ll > 0, 100 * (c - ll) / (hh - ll), 50.0)
    k = np.nan_to_num(k, nan=50.0)
    return k, sma(k, d)


def rolling_vwap(h, l, c, v, n: int = 48) -> np.ndarray:
    tp = (h + l + c) / 3
    pv = rolling_sum(tp * v, n)
    vv = rolling_sum(v, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(vv > 0, pv / vv, sma(c, n))


def obv(c, v) -> np.ndarray:
    d = np.sign(np.diff(c, prepend=c[0]))
    return np.cumsum(d * v)


def efficiency_ratio(c: np.ndarray, n: int = 20) -> np.ndarray:
    """Kaufman efficiency ratio: |net move| / path length (0 = noise, 1 = straight line)."""
    out = np.full(len(c), NAN)
    if len(c) <= n:
        return out
    change = np.abs(c[n:] - c[:-n])
    vol = rolling_sum(np.abs(np.diff(c, prepend=c[0])), n)[n:]
    with np.errstate(invalid="ignore", divide="ignore"):
        out[n:] = np.where(vol > 0, change / vol, 0.0)
    return out


def rolling_corr(x: np.ndarray, y: np.ndarray, n: int) -> np.ndarray:
    mx, my = sma(x, n), sma(y, n)
    mxy = sma(x * y, n)
    sx, sy = rolling_std(x, n), rolling_std(y, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        cov = (mxy - mx * my) * n / max(n - 1, 1)
        return np.where((sx > 0) & (sy > 0), cov / (sx * sy), 0.0)
