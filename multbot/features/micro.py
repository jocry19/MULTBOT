"""Live microstructure state per asset: order book, trade flow, asset context (mark/oracle/funding/OI)."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from ..util import finite


@dataclass
class MicroState:
    coin: str
    bids: list = field(default_factory=list)   # [(px, sz)] best first
    asks: list = field(default_factory=list)
    book_ms: int = 0
    trades: deque = field(default_factory=lambda: deque(maxlen=3000))  # (ms, side(+1 buy aggressor), px, sz)
    mark: float = 0.0
    oracle: float = 0.0
    mid_ctx: float = 0.0
    funding_h: float = 0.0
    premium: float = 0.0
    open_interest: float = 0.0
    day_volume: float = 0.0
    prev_day_px: float = 0.0
    impact_bid: float = 0.0
    impact_ask: float = 0.0
    ctx_ms: int = 0
    oi_hist: deque = field(default_factory=lambda: deque(maxlen=2000))  # (ms, oi)
    last_trade_px: float = 0.0
    oracle_change_ms: int = 0

    # ── updates ───────────────────────────────────────────────────────────
    def update_book(self, levels, ms: int) -> None:
        if not levels or len(levels) < 2:
            return
        self.bids = [(float(x["px"]), float(x["sz"])) for x in levels[0]]
        self.asks = [(float(x["px"]), float(x["sz"])) for x in levels[1]]
        self.book_ms = ms

    def update_trades(self, trades: list) -> None:
        for t in trades:
            side = 1 if t.get("side") == "B" else -1
            px, sz = float(t["px"]), float(t["sz"])
            self.trades.append((int(t["time"]), side, px, sz))
            self.last_trade_px = px

    def update_ctx(self, ctx: dict, ms: int) -> None:
        self.mark = finite(ctx.get("markPx"), self.mark)
        oracle = finite(ctx.get("oraclePx"), self.oracle)
        if oracle != self.oracle or not self.oracle_change_ms:
            self.oracle_change_ms = ms
        self.oracle = oracle
        self.mid_ctx = finite(ctx.get("midPx"), self.mid_ctx)
        self.funding_h = finite(ctx.get("funding"), self.funding_h)
        self.premium = finite(ctx.get("premium"), self.premium)
        self.open_interest = finite(ctx.get("openInterest"), self.open_interest)
        self.day_volume = finite(ctx.get("dayNtlVlm"), self.day_volume)
        self.prev_day_px = finite(ctx.get("prevDayPx"), self.prev_day_px)
        imp = ctx.get("impactPxs") or []
        if len(imp) == 2:
            self.impact_bid, self.impact_ask = finite(imp[0]), finite(imp[1])
        self.ctx_ms = ms
        if not self.oi_hist or ms - self.oi_hist[-1][0] >= 30_000:
            self.oi_hist.append((ms, self.open_interest))

    # ── derived ───────────────────────────────────────────────────────────
    @property
    def best_bid(self) -> float:
        return self.bids[0][0] if self.bids else 0.0

    @property
    def best_ask(self) -> float:
        return self.asks[0][0] if self.asks else 0.0

    @property
    def mid(self) -> float:
        if self.bids and self.asks:
            return (self.best_bid + self.best_ask) / 2
        return self.mid_ctx or self.mark

    @property
    def ref_price(self) -> float:
        return self.mark or self.mid

    def spread_bps(self) -> float:
        m = self.mid
        if not (self.bids and self.asks) or m <= 0:
            if self.impact_bid and self.impact_ask and m > 0:
                return (self.impact_ask - self.impact_bid) / m * 1e4
            return 0.0
        return (self.best_ask - self.best_bid) / m * 1e4

    def imbalance(self, depth: int) -> float:
        b = sum(sz * px for px, sz in self.bids[:depth])
        a = sum(sz * px for px, sz in self.asks[:depth])
        return (b - a) / (b + a) if b + a > 0 else 0.0

    def microprice_bps(self) -> float:
        if not (self.bids and self.asks):
            return 0.0
        (bp, bs), (ap, as_) = self.bids[0], self.asks[0]
        if bs + as_ <= 0:
            return 0.0
        micro = (bp * as_ + ap * bs) / (bs + as_)
        m = (bp + ap) / 2
        return (micro - m) / m * 1e4

    def depth_usd(self, pct: float = 0.02) -> tuple[float, float]:
        m = self.mid
        if m <= 0:
            return 0.0, 0.0
        b = sum(px * sz for px, sz in self.bids if px >= m * (1 - pct))
        a = sum(px * sz for px, sz in self.asks if px <= m * (1 + pct))
        return b, a

    def flow(self, now_ms: int, window_ms: int = 300_000) -> tuple[float, float]:
        """(aggressor imbalance −1…+1, trades per minute) over the window."""
        buy = sell = 0.0
        cnt = 0
        for ms, side, px, sz in reversed(self.trades):
            if now_ms - ms > window_ms:
                break
            cnt += 1
            if side > 0:
                buy += px * sz
            else:
                sell += px * sz
        imb = (buy - sell) / (buy + sell) if buy + sell > 0 else 0.0
        return imb, cnt / (window_ms / 60_000)

    def oi_change(self, now_ms: int, window_ms: int = 3_600_000) -> float:
        if len(self.oi_hist) < 2 or self.open_interest <= 0:
            return 0.0
        base = None
        for ms, oi in self.oi_hist:
            if now_ms - ms <= window_ms:
                base = oi
                break
        if not base:
            return 0.0
        return (self.open_interest - base) / base

    def features(self, now_ms: int) -> dict[str, float]:
        bd, ad = self.depth_usd(0.02)
        imb, rate = self.flow(now_ms)
        return {
            "spread_bps": self.spread_bps(),
            "book_imb5": self.imbalance(5),
            "book_imb20": self.imbalance(20),
            "microprice_bps": self.microprice_bps(),
            "depth_usd": bd + ad,
            "flow_imb": imb,
            "trade_rate": rate,
            "oi_chg": self.oi_change(now_ms),
            "oracle_age_min": (now_ms - self.oracle_change_ms) / 60_000 if self.oracle_change_ms else 0.0,
            "premium_bps": self.premium * 1e4 if self.ctx_ms else 0.0,
            "funding_h": self.funding_h,
        }

    def book_snapshot(self, depth: int = 15) -> dict:
        return {"bids": self.bids[:depth], "asks": self.asks[:depth], "ms": self.book_ms}

    def ctx_snapshot(self) -> dict:
        return {"mark": self.mark, "oracle": self.oracle, "mid": self.mid, "funding_h": self.funding_h,
                "premium": self.premium, "oi": self.open_interest, "oi_usd": self.open_interest * self.mark,
                "day_volume": self.day_volume, "prev_day_px": self.prev_day_px,
                "chg_24h": (self.mark / self.prev_day_px - 1) if self.prev_day_px else 0.0,
                "impact_bid": self.impact_bid, "impact_ask": self.impact_ask, "ms": self.ctx_ms,
                "oracle_change_ms": self.oracle_change_ms}
