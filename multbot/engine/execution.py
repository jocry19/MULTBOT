"""Fill simulation: walks the live L2 book (or a calibrated synthetic book) for taker orders."""
from __future__ import annotations

from dataclasses import dataclass

from ..config import Config
from ..exchange.meta import MarketSpec
from ..features.micro import MicroState


@dataclass
class Fill:
    px: float
    size: float
    notional: float
    fee: float
    slippage_bps: float
    levels: int
    source: str          # "book" | "synthetic"
    shortfall: float     # size beyond visible depth (filled at extrapolated price)


class ExecutionModel:
    def __init__(self, cfg: Config, specs: dict[str, MarketSpec], micro: dict[str, MicroState] | None = None,
                 calib: dict[str, dict] | None = None):
        self.cfg = cfg
        self.specs = specs
        self.micro = micro or {}
        self.calib = calib or {}

    def book_fresh(self, coin: str, now_ms: int) -> bool:
        m = self.micro.get(coin)
        return bool(m and m.bids and m.asks and now_ms - m.book_ms < 120_000)

    def spread_bps(self, coin: str, now_ms: int) -> float:
        if self.book_fresh(coin, now_ms):
            return self.micro[coin].spread_bps()
        if coin in self.calib:
            return float(self.calib[coin].get("spread_bps", self.cfg.execution.synthetic_spread_bps))
        m = self.micro.get(coin)
        if m and m.impact_bid and m.impact_ask and m.mid > 0:
            # impact prices are quoted for a larger notional → scale down to a touch-spread estimate
            return 0.6 * (m.impact_ask - m.impact_bid) / m.mid * 1e4
        return float(self.cfg.execution.synthetic_spread_bps)

    def depth_usd(self, coin: str, side: int, now_ms: int) -> float:
        """Visible depth within 2 % on the side we would take."""
        if self.book_fresh(coin, now_ms):
            b, a = self.micro[coin].depth_usd(0.02)
            return a if side > 0 else b
        return float(self.calib.get(coin, {}).get("depth_usd", 50_000.0)) / 2

    def market(self, coin: str, side: int, size: float, ref_px: float, now_ms: int) -> Fill:
        """Simulate an IOC market order. side=+1 buys (lifts asks), side=−1 sells (hits bids)."""
        spec = self.specs[coin]
        extra = self.cfg.execution.extra_slippage_bps / 1e4
        if self.book_fresh(coin, now_ms):
            m = self.micro[coin]
            levels = m.asks if side > 0 else m.bids
            remaining = size
            cost = 0.0
            used = 0
            last_px = levels[0][0]
            for px, sz in levels:
                if remaining <= 0:
                    break
                take = min(sz, remaining)
                cost += take * px
                remaining -= take
                last_px = px
                used += 1
            shortfall = max(remaining, 0.0)
            if shortfall > 0:
                # beyond visible depth: assume a further 1 % per full book depth consumed
                depth_sz = sum(sz for _, sz in levels) or size
                px_ext = last_px * (1 + side * 0.01 * (1 + shortfall / depth_sz))
                cost += shortfall * px_ext
            avg = cost / size if size > 0 else ref_px
            mid = m.mid or ref_px
            avg *= (1 + side * extra)
            slip = side * (avg - mid) / mid * 1e4 if mid else 0.0
            return Fill(avg, size, avg * size, avg * size * spec.taker_fee, slip, used, "book", shortfall)
        # synthetic: half spread + linear impact against calibrated depth
        cal = self.calib.get(coin, {})
        half = float(cal.get("spread_bps", self.cfg.execution.synthetic_spread_bps)) / 2 / 1e4
        depth = max(float(cal.get("depth_usd", 50_000.0)) / 2, 1.0)
        notional = size * ref_px
        impact = 0.01 * notional / depth
        avg = ref_px * (1 + side * (half + impact + extra))
        slip = side * (avg - ref_px) / ref_px * 1e4
        return Fill(avg, size, avg * size, avg * size * spec.taker_fee, slip, 0, "synthetic", 0.0)

    def maker_price(self, coin: str, side: int, ref_px: float, now_ms: int) -> float:
        """Passive limit price: join the best bid (long) / best ask (short)."""
        if self.book_fresh(coin, now_ms):
            m = self.micro[coin]
            return m.best_bid if side > 0 else m.best_ask
        half = self.spread_bps(coin, now_ms) / 2 / 1e4
        return ref_px * (1 - side * half)

    def maker_fill(self, coin: str, side: int, size: float, px: float, mid: float | None = None) -> Fill:
        spec = self.specs[coin]
        mid = mid or px
        slip = side * (px - mid) / mid * 1e4 if mid else 0.0
        return Fill(px, size, px * size, px * size * spec.maker_fee, slip, 0, "maker", 0.0)

    def round_trip_cost(self, coin: str, now_ms: int) -> float:
        """Approximate round-trip cost as a fraction of notional (fees + spread + extra slippage)."""
        spec = self.specs[coin]
        spread = self.spread_bps(coin, now_ms) / 1e4
        extra = self.cfg.execution.extra_slippage_bps / 1e4
        if self.cfg.execution.entry_mode == "maker":
            return spec.maker_fee + spec.taker_fee + spread / 2 + extra
        return 2 * spec.taker_fee + spread + 2 * extra
