"""Statistical features: volatility estimators, variance ratio / Hurst, autocorrelation, Kalman trend."""
from __future__ import annotations

import math

import numpy as np

from .indicators import NAN, rolling_corr, rolling_mean, rolling_std, shift, sma


def log_returns(c: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.diff(np.log(np.maximum(c, 1e-300)), prepend=np.log(max(c[0], 1e-300)))
    return np.nan_to_num(r)


def parkinson_vol(h, l, n: int = 48) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.log(np.maximum(h, 1e-300) / np.maximum(l, 1e-300)) ** 2
    return np.sqrt(np.maximum(rolling_mean(np.nan_to_num(x), n), 0) / (4 * math.log(2)))


def garman_klass_vol(o, h, l, c, n: int = 48) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        hl = np.log(np.maximum(h, 1e-300) / np.maximum(l, 1e-300)) ** 2
        co = np.log(np.maximum(c, 1e-300) / np.maximum(o, 1e-300)) ** 2
    x = 0.5 * np.nan_to_num(hl) - (2 * math.log(2) - 1) * np.nan_to_num(co)
    return np.sqrt(np.maximum(rolling_mean(x, n), 0))


def variance_ratio(r: np.ndarray, k: int = 4, n: int = 120) -> np.ndarray:
    """Lo-MacKinlay variance ratio VR(k) over a rolling window. >1 trending, <1 mean-reverting."""
    rk = np.convolve(r, np.ones(k), mode="full")[: len(r)]
    v1 = rolling_std(r, n) ** 2
    vk = rolling_std(rk, n) ** 2
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(v1 > 0, vk / (k * v1), 1.0)


def hurst_from_vr(vr: np.ndarray, k: int = 4) -> np.ndarray:
    """Hurst exponent implied by the variance ratio: VR(k) ≈ k^(2H-1)."""
    with np.errstate(invalid="ignore", divide="ignore"):
        h = 0.5 + np.log(np.maximum(vr, 1e-6)) / (2 * math.log(k))
    return np.clip(np.nan_to_num(h, nan=0.5), 0.0, 1.0)


def autocorr(r: np.ndarray, lag: int = 1, n: int = 100) -> np.ndarray:
    return rolling_corr(r, shift(r, lag, 0.0), n)


def kalman_trend(c: np.ndarray, q_level: float = 0.5, q_slope: float = 2e-3, r_obs: float = 0.5):
    """Local linear trend Kalman filter on log price.

    Returns (level, slope, slope_std) where slope is the per-bar drift estimate.
    Noise variances are fractions of the series' own per-bar return variance so the
    filter adapts to each asset's volatility.
    """
    y = np.log(np.maximum(c, 1e-300))
    n = len(y)
    level = np.zeros(n)
    slope = np.zeros(n)
    slope_sd = np.zeros(n)
    if n == 0:
        return level, slope, slope_sd
    # causal EWMA estimate of the per-bar return variance (seeded from the warm-up bars)
    d = np.diff(y, prepend=y[0])
    rv = max(float(np.var(d[1:51])) if n > 3 else 1e-6, 1e-12)
    lv, sl = float(y[0]), 0.0
    p00, p01, p11 = rv * 10, 0.0, rv * 10
    yl = y.tolist()
    dl = d.tolist()
    for i in range(n):
        if i:
            rv = max(0.98 * rv + 0.02 * dl[i] * dl[i], 1e-12)
        # predict (F = [[1,1],[0,1]])
        lv += sl
        p00 = p00 + 2 * p01 + p11 + q_level * rv
        p01 = p01 + p11
        p11 = p11 + q_slope * rv
        # update with observation of the level
        s = p00 + r_obs * rv
        k0, k1 = p00 / s, p01 / s
        innov = yl[i] - lv
        lv += k0 * innov
        sl += k1 * innov
        p00, p01, p11 = p00 - k0 * p00, p01 - k0 * p01, p11 - k1 * p01
        level[i] = lv
        slope[i] = sl
        slope_sd[i] = math.sqrt(max(p11, 1e-18))
    return np.exp(level), slope, slope_sd


def rolling_skew(r: np.ndarray, n: int = 96) -> np.ndarray:
    m = sma(r, n)
    s = rolling_std(r, n)
    m3 = sma(r ** 3, n) - 3 * m * sma(r ** 2, n) + 2 * m ** 3
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(s > 0, m3 / s ** 3, 0.0)


def stale_fraction(h, l, v, n: int = 12) -> np.ndarray:
    """Share of the last n bars with zero range and zero volume (market asleep / oracle frozen)."""
    flat = ((h - l) <= 0) & (v <= 0)
    return np.nan_to_num(sma(flat.astype(float), n), nan=1.0)


__all__ = ["log_returns", "parkinson_vol", "garman_klass_vol", "variance_ratio", "hurst_from_vr", "autocorr",
           "kalman_trend", "rolling_skew", "stale_fraction", "NAN"]
