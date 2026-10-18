"""Position sizing (always at max leverage) and pre-trade risk checks."""
from __future__ import annotations

from dataclasses import dataclass

from ..config import Config
from ..exchange.meta import MarketSpec
from ..util import clamp, floor_to_decimals


@dataclass
class SizedOrder:
    side: int
    size: float
    margin: float
    notional: float
    leverage: int
    stop_px: float
    tp_px: float
    liq_px: float
    stop_dist: float
    margin_pct: float
    notes: list


def liq_price(entry: float, side: int, margin: float, size: float, maint_rate: float) -> float:
    return max((entry - side * margin / size) / (1 - side * maint_rate), 0.0)


class RiskManager:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def margin_fraction(self, final: float, pwin: float | None) -> float:
        r = self.cfg.risk
        th = self.cfg.signal.entry_threshold
        scale = clamp((abs(final) - th) / max(1 - th, 1e-6), 0.0, 1.0)
        frac = r.base_margin_pct * (0.6 + 0.8 * scale ** 0.7)
        if pwin is not None:
            # fractional-Kelly style tilt: more margin when the meta model sees an edge
            frac *= clamp(1 + (pwin - 0.55) * 4, 0.5, 1.5)
        return clamp(frac, r.min_margin_pct, r.max_margin_pct)

    def size(self, spec: MarketSpec, side: int, px: float, atr: float, equity: float, free_balance: float,
             final: float, pwin: float | None, spread_bps: float, depth_usd: float) -> tuple[SizedOrder | None, str]:
        r = self.cfg.risk
        lev = spec.leverage
        notes: list[str] = []
        frac = self.margin_fraction(final, pwin)
        margin = equity * frac
        fee_buf = 1 + lev * spec.taker_fee * 2
        margin = min(margin, free_balance / fee_buf * 0.995)
        notional = margin * lev
        if notional < r.min_notional:
            need = r.min_notional * 1.02 / lev
            if need * fee_buf <= free_balance:
                margin = need
                notional = margin * lev
                notes.append("auf Mindestorder angehoben")
            else:
                return None, f"zu wenig freies Guthaben für Mindestorder ({free_balance:.2f} USD)"
        cap = r.max_book_participation * depth_usd if depth_usd > 0 else notional
        if notional > cap:
            if cap < r.min_notional:
                return None, f"Buchtiefe zu gering ({depth_usd:,.0f} USD in ±2 %)"
            notional = cap
            margin = notional / lev
            notes.append(f"auf {r.max_book_participation:.0%} der Buchtiefe begrenzt")
        size = floor_to_decimals(notional / px, spec.sz_decimals)
        if size <= 0 or size * px < r.min_notional * 0.99:
            return None, "Größe nach Rundung unter Mindestorder"
        notional = size * px
        margin = notional / lev
        lp = liq_price(px, side, margin, size, spec.maint_rate)
        liq_dist = abs(px - lp)
        min_stop = px * max(0.002, 2.5 * spread_bps / 1e4)
        stop_dist = max(r.stop_atr * atr, min_stop)
        max_stop = r.stop_liq_frac * liq_dist
        if stop_dist > max_stop:
            if min_stop > max_stop:
                return None, "Stop würde hinter dem Liquidationspreis liegen"
            stop_dist = max_stop
            notes.append("Stop vor Liquidation gezogen")
        stop_px = px - side * stop_dist
        tp_px = px + side * r.tp_r * stop_dist
        return SizedOrder(side, size, margin, notional, lev, stop_px, tp_px, lp, stop_dist, margin / equity,
                          notes), ""
