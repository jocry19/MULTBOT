"""Strategy library. Every strategy maps a feature row to a score in [−1, +1] and a short reason.

+1 = maximal long conviction, −1 = maximal short conviction, 0 = no opinion.
The learning layer decides how much each strategy is trusted per asset and regime.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

Score = tuple[float, str]


def _t(x: float) -> float:
    return math.tanh(x)


def _c(x: float) -> float:
    return max(-1.0, min(1.0, x))


@dataclass(frozen=True)
class StrategyDef:
    key: str
    name: str
    family: str
    description: str
    fn: Callable[[dict], Score]
    live_only: bool = False


# ── trend / momentum ─────────────────────────────────────────────────────────
def ema_trend(f) -> Score:
    x = 0.8 * f["ema_spread"] + 2.0 * f["ema_slope"]
    align = f["ema_align"]
    s = _t(x)
    if align and (align > 0) != (s > 0):
        s *= 0.4
    return s, f"EMA9/21-Spread {f['ema_spread']:+.2f} ATR, Steigung {f['ema_slope']:+.3f}"


def macd_momentum(f) -> Score:
    z = f["macd_hist_z"]
    return _t(z / 1.6), f"MACD-Hist z {z:+.2f}"


def donchian_breakout(f) -> Score:
    b = f["don_break"]
    if b == 0.0:
        return 0.0, "kein Ausbruch"
    conf = 0.55 + 0.45 / (1 + math.exp(-f["vol_z"]))
    return _c((0.6 + min(abs(b), 2.0) * 0.25) * conf) * (1 if b > 0 else -1), f"Ausbruch {b:+.2f} ATR, Vol z {f['vol_z']:+.1f}"


def kalman_trend(f) -> Score:
    z = f["kf_slope_z"]
    return _t(z / 2.5), f"Kalman-Drift z {z:+.2f}"


def tsmom(f) -> Score:
    return _c(f["tsmom"] * 1.4), f"TS-Momentum {f['tsmom']:+.2f}"


def adx_dmi(f) -> Score:
    strength = min(1.0, max(0.0, (f["adx"] - 15) / 20))
    return _c(f["dmi"] * 1.6) * strength, f"ADX {f['adx']:.0f}, DMI {f['dmi']:+.2f}"


def squeeze_release(f) -> Score:
    if f["squeeze_prev"] >= 1 and f["squeeze"] < 1:
        d = f["macd_hist_z"] + f["ret_3n"]
        return _c(0.85 * (1 if d > 0 else -1)), f"Squeeze gelöst, Richtung {'↑' if d > 0 else '↓'}"
    if f["squeeze"] >= 1:
        return 0.0, "Squeeze aktiv – warten"
    return 0.0, "kein Squeeze"


def vol_ignition(f) -> Score:
    z = f["ret_z"]
    if abs(z) > 2.5 and f["vol_z"] > 1.0:
        return _c(0.7 * (1 if z > 0 else -1)), f"Impuls {z:+.1f}σ bei Volumen z {f['vol_z']:+.1f}"
    return 0.0, f"kein Impuls ({z:+.1f}σ)"


# ── mean reversion ──────────────────────────────────────────────────────────
def bollinger_reversion(f) -> Score:
    z = f["bb_z"]
    if abs(z) < 1.0:
        return 0.0, f"BB z {z:+.2f} (neutral)"
    damp = 1.0 - min(1.0, max(0.0, (f["adx"] - 25) / 20))
    return -_t((z - math.copysign(1.0, z)) * 1.2 + math.copysign(0.3, z)) * damp, f"BB z {z:+.2f}, ADX-Dämpfung {damp:.2f}"


def rsi_reversion(f) -> Score:
    r = f["rsi_14"]
    if 30 <= r <= 70:
        return 0.0, f"RSI {r:.0f} (neutral)"
    s = (30 - r) / 20 if r < 30 else -(r - 70) / 20
    hurst_adj = 1.0 if f["hurst"] < 0.55 else 0.5
    return _c(s) * hurst_adj, f"RSI {r:.0f}, Hurst {f['hurst']:.2f}"


def vwap_reversion(f) -> Score:
    d = f["vwap_dev"]
    if abs(d) < 0.8:
        return 0.0, f"VWAP-Abstand {d:+.2f} ATR"
    trend_pen = 0.5 if f["er_20"] > 0.5 else 1.0
    return -_t(d / 2.5) * trend_pen, f"VWAP-Abstand {d:+.2f} ATR"


def kalman_reversion(f) -> Score:
    d = f["kf_dev"]
    if f["hurst"] > 0.55 or abs(d) < 0.7:
        return 0.0, f"Kalman-Abstand {d:+.2f}"
    return -_t(d / 1.5), f"Kalman-Abstand {d:+.2f} ATR, Hurst {f['hurst']:.2f}"


def stoch_reversal(f) -> Score:
    k, d = f["stoch_k"], f["stoch_d"]
    if k < 20 and k > d:
        return 0.6, f"Stoch %K {k:.0f} kreuzt %D aufwärts"
    if k > 80 and k < d:
        return -0.6, f"Stoch %K {k:.0f} kreuzt %D abwärts"
    return 0.0, f"Stoch %K {k:.0f}"


def range_fade(f) -> Score:
    if f["hurst"] >= 0.5 or f["adx"] > 25:
        return 0.0, "kein Range-Regime"
    p = f["range_pos"]
    return _c(-(p - 0.5) * 2.2), f"Range-Position {p:.2f}"


# ── carry / positioning ─────────────────────────────────────────────────────
def funding_contrarian(f) -> Score:
    z = f["funding_z"]
    lvl = f["funding_h"] / 0.00015
    s = -0.55 * _t(z / 2.0) - 0.45 * _t(lvl)
    return _c(s), f"Funding {f['funding_h'] * 100:+.4f}%/h, z {z:+.2f}"


def premium_reversion(f) -> Score:
    p = f["premium_bps"]
    if abs(p) < 5:
        return 0.0, f"Prämie {p:+.1f} bps"
    return -_t(p / 35), f"Mark/Oracle-Prämie {p:+.1f} bps"


# ── microstructure (live only) ──────────────────────────────────────────────
def book_imbalance(f) -> Score:
    imb = 0.6 * f["book_imb5"] + 0.4 * f["book_imb20"]
    mp = f["microprice_bps"]
    if imb == 0 and mp == 0:
        return 0.0, "kein Orderbuch"
    return _t(1.8 * imb + mp / 6), f"Imbalance {imb:+.2f}, Microprice {mp:+.1f} bps"


def trade_flow(f) -> Score:
    fi, rate = f["flow_imb"], f["trade_rate"]
    if rate <= 0:
        return 0.0, "keine Trades"
    return _t(1.6 * fi) * min(1.0, rate / 2.0), f"Fluss {fi:+.2f}, {rate:.1f} Trades/min"


def oi_confirmation(f) -> Score:
    oi = f["oi_chg"]
    if abs(oi) < 0.003:
        return 0.0, f"OI Δ {oi * 100:+.2f}%"
    direction = 1 if f["ret_12"] > 0 else -1
    # rising OI with price = new positions confirm the move; falling OI = squeeze/unwind, fade it
    return _t(oi / 0.02) * direction, f"OI Δ1h {oi * 100:+.2f}% bei Kurs {'↑' if direction > 0 else '↓'}"


STRATEGIES: list[StrategyDef] = [
    StrategyDef("ema_trend", "EMA-Trend", "Trend", "EMA 9/21/55 Ausrichtung + Steigung, ATR-normiert", ema_trend),
    StrategyDef("macd_mom", "MACD-Momentum", "Trend", "z-normiertes MACD-Histogramm", macd_momentum),
    StrategyDef("donchian", "Donchian-Breakout", "Breakout", "20-Bar-Ausbruch mit Volumenbestätigung",
                donchian_breakout),
    StrategyDef("kalman", "Kalman-Trend", "Trend", "Drift eines Local-Linear-Trend-Kalman-Filters", kalman_trend),
    StrategyDef("tsmom", "TS-Momentum", "Trend", "Zeitreihen-Momentum über 12/48/144 Bars", tsmom),
    StrategyDef("adx_dmi", "ADX/DMI", "Trend", "Richtungsindikator gewichtet mit Trendstärke", adx_dmi),
    StrategyDef("squeeze", "Vola-Squeeze", "Breakout", "Bollinger in Keltner → Ausbruchsrichtung", squeeze_release),
    StrategyDef("ignition", "Impuls-Zündung", "Breakout", "Rendite > 2,5σ mit Volumenspitze", vol_ignition),
    StrategyDef("bb_revert", "Bollinger-Reversion", "Reversion", "Rückkehr zur Mitte, gedämpft bei starkem Trend",
                bollinger_reversion),
    StrategyDef("rsi_revert", "RSI-Reversion", "Reversion", "RSI-Extreme, Hurst-gefiltert", rsi_reversion),
    StrategyDef("vwap_revert", "VWAP-Reversion", "Reversion", "Abweichung vom rollierenden VWAP", vwap_reversion),
    StrategyDef("kf_revert", "Kalman-Reversion", "Reversion", "Abstand zum Kalman-Level bei Hurst < 0,55",
                kalman_reversion),
    StrategyDef("stoch", "Stochastik-Wende", "Reversion", "%K/%D-Kreuzung in Extremzonen", stoch_reversal),
    StrategyDef("range_fade", "Range-Fade", "Reversion", "Ränder der 96-Bar-Range im Seitwärtsmarkt", range_fade),
    StrategyDef("funding", "Funding-Kontra", "Carry", "Gegen überfüllte Seite + Funding-Carry",
                funding_contrarian),
    StrategyDef("premium", "Prämien-Reversion", "Carry", "Mark/Oracle-Prämie konvergiert", premium_reversion),
    StrategyDef("book", "Orderbuch-Druck", "Mikrostruktur", "Tiefen-Imbalance + Microprice", book_imbalance,
                live_only=True),
    StrategyDef("flow", "Order-Flow", "Mikrostruktur", "Aggressor-Kauf/Verkauf-Fluss", trade_flow, live_only=True),
    StrategyDef("oi", "OI-Bestätigung", "Mikrostruktur", "Open-Interest-Änderung vs. Kursrichtung", oi_confirmation,
                live_only=True),
]

STRATEGY_KEYS = [s.key for s in STRATEGIES]
ML_KEY = "ml"
ALL_KEYS = STRATEGY_KEYS + [ML_KEY]
BY_KEY = {s.key: s for s in STRATEGIES}


def evaluate_all(f: dict[str, float]) -> dict[str, Score]:
    out: dict[str, Score] = {}
    for s in STRATEGIES:
        try:
            score, why = s.fn(f)
            if not math.isfinite(score):
                score = 0.0
        except (KeyError, ValueError, ZeroDivisionError, OverflowError) as e:
            score, why = 0.0, f"Fehler: {e}"
        out[s.key] = (_c(score), why)
    return out


def catalog() -> list[dict]:
    rows = [{"key": s.key, "name": s.name, "family": s.family, "description": s.description,
             "live_only": s.live_only} for s in STRATEGIES]
    rows.append({"key": ML_KEY, "name": "Online-ML (Logit)", "family": "ML",
                 "description": "Online-logistische Regression über ~40 Features (AdaGrad, L2)", "live_only": False})
    return rows
