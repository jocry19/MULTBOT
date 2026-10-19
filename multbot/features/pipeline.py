"""Feature pipeline: turns OHLCV (+ funding) into ~60 aligned feature series."""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np

from ..util import HOUR_MS
from . import indicators as ta
from . import stats as st

# name → German description (shown in the dashboard's feature lab)
FEATURES: dict[str, str] = {
    "close": "Schlusskurs",
    "ret_1": "Log-Rendite 1 Bar",
    "ret_3": "Log-Rendite 3 Bars",
    "ret_12": "Log-Rendite 12 Bars",
    "ret_48": "Log-Rendite 48 Bars",
    "vol": "Realisierte Vola pro Bar (48)",
    "vol_pct": "Vola-Perzentil (288 Bars)",
    "atr": "Average True Range (14)",
    "atr_pct": "ATR in % vom Kurs",
    "ema_spread": "(EMA9 − EMA21) / ATR",
    "ema_slope": "Steigung EMA21 in ATR/Bar",
    "ema_align": "Trend-Ausrichtung Kurs/EMA21/EMA55 (−1…+1)",
    "ema200_dev": "Abstand zur EMA200 in ATR",
    "rsi_14": "RSI 14",
    "rsi_7": "RSI 7",
    "macd_hist_z": "MACD-Histogramm (z-Score)",
    "bb_z": "Bollinger z-Score (20, 2σ)",
    "bb_width": "Bollinger-Bandbreite",
    "bb_width_rank": "Bandbreiten-Perzentil (200)",
    "squeeze": "Squeeze aktiv (BB in Keltner)",
    "squeeze_prev": "Squeeze in den letzten 6 Bars",
    "don_break": "Donchian-Ausbruch (20) in ATR",
    "don_pos": "Position im Donchian-Kanal (0…1)",
    "adx": "ADX 14 (Trendstärke)",
    "dmi": "(+DI − −DI)/(+DI + −DI)",
    "stoch_k": "Stochastik %K",
    "stoch_d": "Stochastik %D",
    "vwap_dev": "Abstand zum rollierenden VWAP (48) in ATR",
    "vol_z": "Volumen z-Score",
    "ret_z": "Bar-Rendite / Vola",
    "rng_z": "Spannweite der Bar (Hoch/Tief) / Vola",
    "er_20": "Kaufman Efficiency Ratio (20)",
    "vr_4": "Varianz-Ratio VR(4)",
    "hurst": "Hurst-Exponent (aus VR)",
    "ac_1": "Autokorrelation Lag 1",
    "kf_slope_z": "Kalman-Drift / Unsicherheit",
    "kf_dev": "Abstand zum Kalman-Level in ATR",
    "park_vol": "Parkinson-Vola",
    "gk_vol": "Garman-Klass-Vola",
    "skew": "Schiefe der Renditen (96)",
    "obv_flow": "OBV-Fluss (12) normiert",
    "stale": "Anteil eingefrorener Bars (12)",
    "funding_h": "Funding-Rate pro Stunde",
    "funding_z": "Funding z-Score (72 h)",
    "funding_ann": "Funding annualisiert",
    "premium_bps": "Mark/Oracle-Prämie in bps",
    "hour_sin": "Tageszeit sin",
    "hour_cos": "Tageszeit cos",
    "session": "Gelerntes Aktivitätsprofil dieser Tageszeit (0 = Markt schläft, 1 = aktiv)",
    "tsmom": "Zeitreihen-Momentum (12/48/144)",
    "range_pos": "Position in der 96-Bar-Range",
    # live microstructure (0 in historical replay)
    "spread_bps": "Geld/Brief-Spanne in bps",
    "book_imb5": "Orderbuch-Ungleichgewicht Top 5",
    "book_imb20": "Orderbuch-Ungleichgewicht Top 20",
    "microprice_bps": "Microprice vs. Mid in bps",
    "depth_usd": "Buchtiefe ±2 % in USD",
    "flow_imb": "Aggressor-Fluss Kauf/Verkauf (5 min)",
    "trade_rate": "Trades pro Minute",
    "oi_chg": "Open-Interest-Änderung 1 h",
    "oracle_age_min": "Minuten seit der letzten Oracle-Bewegung (live)",
    "lead_ret_1": "Rendite des Leitmarkts (BTC bzw. XYZ100) letzte Bar, vola-normiert",
    "lead_ret_3": "Rendite des Leitmarkts letzte 3 Bars, vola-normiert",
    "lead_beta": "Beta zum Leitmarkt (288 Bars)",
    "lag_gap": "Nachhol-Lücke: Beta × Leitmarkt-Bewegung − eigene Bewegung (3 Bars, in σ)",
}

MICRO_KEYS = ["spread_bps", "book_imb5", "book_imb20", "microprice_bps", "depth_usd", "flow_imb",
              "trade_rate", "oi_chg", "oracle_age_min"]

# features fed to the online ML models (standardised online)
ML_FEATURES = ["ret_z", "ret_3n", "ret_12n", "ema_spread", "ema_slope", "ema_align", "ema200_dev", "rsi_c",
               "macd_hist_z", "bb_z", "bb_width_rank", "squeeze_prev", "don_break", "don_pos_c", "adx_n", "dmi",
               "stoch_c", "vwap_dev", "vol_z", "er_20", "hurst_c", "ac_1", "kf_slope_z", "kf_dev", "skew",
               "obv_flow", "funding_z", "premium_bps", "hour_sin", "hour_cos", "session", "tsmom", "vol_pct",
               "range_pos_c", "book_imb5", "book_imb20", "microprice_bps", "flow_imb", "oi_chg",
               "lead_ret_1", "lead_ret_3", "lag_gap"]

LEADERS = {"crypto": "BTC", "equity": "xyz:XYZ100", "etf": "xyz:XYZ100"}


def leader_of(coin: str, asset_class: str, available) -> str | None:
    """Market whose moves this market tends to follow (BTC for crypto, the XYZ100 index for stocks)."""
    lead = LEADERS.get(asset_class)
    if lead is None or lead == coin or lead not in available:
        return None
    return lead


def align_leader(t: np.ndarray, lead_t: np.ndarray, lead_c: np.ndarray) -> np.ndarray | None:
    """Leader closes at the same bar timestamps (forward-filled); None if there is no overlap."""
    if len(lead_t) == 0 or len(t) == 0:
        return None
    idx = np.searchsorted(lead_t, t, side="right") - 1
    if (idx >= 0).sum() < len(t) * 0.5:
        return None
    out = lead_c[np.clip(idx, 0, len(lead_c) - 1)].astype(float)
    first_valid = int(np.argmax(idx >= 0))
    out[:first_valid] = out[first_valid]
    return out


def activity_profile(t: np.ndarray, active: np.ndarray, alpha: float = 0.08, prior: float = 0.5) -> np.ndarray:
    """Causal per-bucket activity (weekday/weekend × hour of day, UTC).

    Learns each market's own trading hours from the data – US, Korean, Japanese or Chinese
    stocks, commodities, FX and 24/7 crypto alike – without hard-coded exchange calendars.
    The value at bar i only uses bars before i that fell into the same bucket.
    """
    hours = ((t // 3_600_000) % 24).astype(np.int64)
    dow = ((t // 86_400_000) + 3) % 7               # 1970-01-01 was a Thursday → 0 = Monday
    bucket = (hours + 24 * (dow >= 5)).tolist()
    prof = [prior] * 48
    out = np.empty(len(t))
    for i, (b, act) in enumerate(zip(bucket, active.tolist())):
        out[i] = prof[b]
        prof[b] += alpha * (act - prof[b])
    return out


def compute_features(a: dict[str, np.ndarray], interval_ms: int, funding_h: np.ndarray | None = None,
                     premium: np.ndarray | None = None, lead: np.ndarray | None = None) -> dict[str, np.ndarray]:
    t, o, h, l, c, v = a["t"], a["o"], a["h"], a["l"], a["c"], a["v"]
    n = len(c)
    f: dict[str, np.ndarray] = {"t": t.astype(float), "close": c}
    r = st.log_returns(c)
    f["ret_1"] = r
    for k in (3, 12, 48):
        f[f"ret_{k}"] = np.nan_to_num(np.log(np.maximum(c, 1e-300) / np.maximum(ta.shift(c, k, c[0] if n else 0), 1e-300)))
    vol = np.nan_to_num(ta.rolling_std(r, 48), nan=np.nanstd(r[: min(n, 48)]) if n > 2 else 0.0)
    vol = np.maximum(vol, 1e-6)
    f["vol"] = vol
    f["vol_pct"] = np.nan_to_num(ta.rolling_rank(vol, min(288, max(n - 1, 2))), nan=0.5)
    atr = np.maximum(ta.atr(h, l, c, 14), c * 1e-5)
    f["atr"] = atr
    f["atr_pct"] = atr / np.maximum(c, 1e-300)
    e9, e21, e55, e200 = ta.ema(c, 9), ta.ema(c, 21), ta.ema(c, 55), ta.ema(c, 200)
    f["ema_spread"] = (e9 - e21) / atr
    f["ema_slope"] = (e21 - ta.shift(e21, 3, e21[0] if n else 0)) / atr / 3
    f["ema_align"] = np.where((c > e21) & (e21 > e55), 1.0, np.where((c < e21) & (e21 < e55), -1.0, 0.0))
    f["ema200_dev"] = (c - e200) / atr
    f["rsi_14"] = ta.rsi(c, 14)
    f["rsi_7"] = ta.rsi(c, 7)
    _, _, hist = ta.macd(c)
    hsd = ta.rolling_std(hist, 100)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["macd_hist_z"] = np.nan_to_num(np.where(hsd > 0, hist / hsd, 0.0))
    mid, up, lo, sd = ta.bollinger(c, 20, 2.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["bb_z"] = np.nan_to_num(np.where(sd > 0, (c - mid) / sd, 0.0))
    bbw = np.nan_to_num((up - lo) / np.maximum(mid, 1e-300))
    f["bb_width"] = bbw
    f["bb_width_rank"] = np.nan_to_num(ta.rolling_rank(bbw, min(200, max(n - 1, 2))), nan=0.5)
    _, ku, kl = ta.keltner(h, l, c, 20, 1.5)
    sq = np.nan_to_num(((up < ku) & (lo > kl)).astype(float))
    f["squeeze"] = sq
    f["squeeze_prev"] = np.nan_to_num(ta.shift(ta.rolling_max(sq, 6), 1), nan=0.0)
    dh = ta.shift(ta.rolling_max(h, 20), 1)
    dl = ta.shift(ta.rolling_min(l, 20), 1)
    with np.errstate(invalid="ignore"):
        brk = np.where(c > dh, (c - dh) / atr, np.where(c < dl, (c - dl) / atr, 0.0))
    f["don_break"] = np.nan_to_num(brk)
    hh, ll = ta.rolling_max(h, 20), ta.rolling_min(l, 20)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["don_pos"] = np.nan_to_num(np.where(hh - ll > 0, (c - ll) / (hh - ll), 0.5), nan=0.5)
    adx, pdi, mdi = ta.adx(h, l, c, 14)
    f["adx"] = adx
    with np.errstate(invalid="ignore", divide="ignore"):
        f["dmi"] = np.where(pdi + mdi > 0, (pdi - mdi) / (pdi + mdi), 0.0)
    k, d = ta.stochastic(h, l, c, 14, 3)
    f["stoch_k"] = k
    f["stoch_d"] = np.nan_to_num(d, nan=50.0)
    f["vwap_dev"] = np.nan_to_num((c - ta.rolling_vwap(h, l, c, v, 48)) / atr)
    f["vol_z"] = np.nan_to_num(ta.zscore(np.log1p(np.maximum(v, 0)), 96))
    f["ret_z"] = r / vol
    with np.errstate(divide="ignore", invalid="ignore"):   # the bar's own high–low range in σ units
        f["rng_z"] = np.nan_to_num(np.log(np.maximum(h, 1e-300) / np.maximum(l, 1e-300)) / vol, posinf=0.0)
    f["er_20"] = np.nan_to_num(ta.efficiency_ratio(c, 20))
    vr = np.nan_to_num(st.variance_ratio(r, 4, 120), nan=1.0)
    f["vr_4"] = vr
    f["hurst"] = st.hurst_from_vr(vr, 4)
    f["ac_1"] = np.nan_to_num(st.autocorr(r, 1, 100))
    lvl, slope, slope_sd = st.kalman_trend(c)
    f["kf_slope_z"] = np.clip(slope / np.maximum(slope_sd, 1e-12), -10, 10)
    f["kf_dev"] = (c - lvl) / atr
    f["park_vol"] = np.nan_to_num(st.parkinson_vol(h, l, 48))
    f["gk_vol"] = np.nan_to_num(st.garman_klass_vol(o, h, l, c, 48))
    f["skew"] = np.clip(np.nan_to_num(st.rolling_skew(r, 96)), -5, 5)
    ob = ta.obv(c, v)
    vs = ta.rolling_sum(v, 12)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["obv_flow"] = np.nan_to_num(np.where(vs > 0, (ob - ta.shift(ob, 12, 0.0)) / vs, 0.0))
    f["stale"] = st.stale_fraction(h, l, v, 12)

    fr = np.zeros(n) if funding_h is None else np.nan_to_num(funding_h)
    f["funding_h"] = fr
    nb = max(int(72 * HOUR_MS / interval_ms), 24)
    f["funding_z"] = np.clip(np.nan_to_num(ta.zscore(fr, min(nb, max(n, 2)))), -6, 6)
    f["funding_ann"] = fr * 24 * 365
    f["premium_bps"] = (np.zeros(n) if premium is None else np.nan_to_num(premium)) * 1e4

    hours = ((t // 1000) % 86400) / 3600.0
    f["hour_sin"] = np.sin(2 * math.pi * hours / 24)
    f["hour_cos"] = np.cos(2 * math.pi * hours / 24)
    f["session"] = activity_profile(t, (((h - l) > 0) | (v > 0)).astype(float))
    tsm = np.zeros(n)
    for kk in (12, 48, 144):
        rk = np.nan_to_num(np.log(np.maximum(c, 1e-300) / np.maximum(ta.shift(c, kk, c[0] if n else 0), 1e-300)))
        tsm += np.tanh(rk / (vol * math.sqrt(kk)) / 2)
    f["tsmom"] = tsm / 3
    rh, rl = ta.rolling_max(h, 96), ta.rolling_min(l, 96)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["range_pos"] = np.nan_to_num(np.where(rh - rl > 0, (c - rl) / (rh - rl), 0.5), nan=0.5)
    for key in MICRO_KEYS:
        f[key] = np.zeros(n)
    # lead-lag versus the leader market (crypto → BTC, stocks → XYZ100 index)
    if lead is not None and len(lead) == n and n > 10:
        lr = st.log_returns(lead)
        lvol = np.maximum(np.nan_to_num(ta.rolling_std(lr, 48), nan=np.nanstd(lr[: min(n, 48)])), 1e-6)
        lr3 = np.nan_to_num(np.log(np.maximum(lead, 1e-300) / np.maximum(ta.shift(lead, 3, lead[0]), 1e-300)))
        wnd = min(288, max(n - 1, 10))
        cov = ta.sma(r * lr, wnd) - ta.sma(r, wnd) * ta.sma(lr, wnd)
        var = ta.sma(lr * lr, wnd) - ta.sma(lr, wnd) ** 2
        with np.errstate(invalid="ignore", divide="ignore"):
            beta = np.clip(np.nan_to_num(np.where(var > 1e-14, cov / var, 0.0)), -3, 3)
        f["lead_ret_1"] = lr / lvol
        f["lead_ret_3"] = lr3 / (lvol * math.sqrt(3))
        f["lead_beta"] = beta
        f["lag_gap"] = np.clip((beta * lr3 - f["ret_3"]) / (vol * math.sqrt(3)), -8, 8)
    else:
        for key in ("lead_ret_1", "lead_ret_3", "lead_beta", "lag_gap"):
            f[key] = np.zeros(n)
    # derived / centred variants used by the ML model
    f["ret_3n"] = f["ret_3"] / (vol * math.sqrt(3))
    f["ret_12n"] = f["ret_12"] / (vol * math.sqrt(12))
    f["rsi_c"] = (f["rsi_14"] - 50) / 50
    f["don_pos_c"] = f["don_pos"] - 0.5
    f["adx_n"] = f["adx"] / 50
    f["stoch_c"] = (f["stoch_k"] - 50) / 50
    f["hurst_c"] = f["hurst"] - 0.5
    f["range_pos_c"] = f["range_pos"] - 0.5
    for key, arr in f.items():
        f[key] = np.nan_to_num(np.asarray(arr, dtype=float))
    return f


def row(f: dict[str, np.ndarray], i: int = -1) -> dict[str, float]:
    return {k: float(v[i]) for k, v in f.items()}


def ml_vector(r: dict[str, float]) -> np.ndarray:
    x = np.array([r.get(k, 0.0) for k in ML_FEATURES], dtype=float)
    if not np.isfinite(x).all():
        np.nan_to_num(x, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    return x


def hour_utc(ms: int) -> int:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).hour
