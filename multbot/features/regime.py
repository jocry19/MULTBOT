"""Market regime classification (trend × volatility) plus tradability state."""
from __future__ import annotations

from dataclasses import dataclass

TRENDS = ("TREND", "RANGE", "NEUTRAL")
VOLS = ("LOW", "MID", "HIGH")
REGIMES = [f"{t}-{v}" for t in TRENDS for v in VOLS]


@dataclass
class Regime:
    trend: str
    vol: str
    trend_dir: int       # +1 up, −1 down, 0 none
    tradable: bool
    why: str = ""

    @property
    def label(self) -> str:
        return f"{self.trend}-{self.vol}"

    def to_dict(self) -> dict:
        return {"label": self.label, "trend": self.trend, "vol": self.vol, "dir": self.trend_dir,
                "tradable": self.tradable, "why": self.why}


def classify(f: dict[str, float], stale_limit: float = 0.75, max_oracle_age_min: float = 0.0) -> Regime:
    adx = f.get("adx", 0.0)
    er = f.get("er_20", 0.0)
    hurst = f.get("hurst", 0.5)
    trend_score = (adx - 20) / 15 + (er - 0.3) * 2.5 + (hurst - 0.5) * 4
    if trend_score > 0.6:
        trend = "TREND"
    elif trend_score < -0.4:
        trend = "RANGE"
    else:
        trend = "NEUTRAL"
    vp = f.get("vol_pct", 0.5)
    vol = "LOW" if vp < 0.33 else "HIGH" if vp > 0.80 else "MID"
    d = f.get("dmi", 0.0) + 0.5 * f.get("ema_align", 0.0)
    trend_dir = 1 if d > 0.15 else -1 if d < -0.15 else 0
    tradable, why = True, ""
    oracle_age = f.get("oracle_age_min", 0.0)
    if f.get("stale", 0.0) > stale_limit:
        tradable, why = False, "Markt schläft (eingefrorene Bars)"
    elif max_oracle_age_min > 0 and oracle_age > max_oracle_age_min:
        tradable, why = False, f"Oracle seit {oracle_age:.0f} min eingefroren (Börse des Basiswerts zu)"
    return Regime(trend, vol, trend_dir, tradable, why)
