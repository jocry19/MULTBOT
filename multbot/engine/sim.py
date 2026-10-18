"""Synthetic perp market: regime-switching price paths, funding, order books and trade flow.

The generator deliberately embeds *some* exploitable structure (persistent drift regimes, order-flow that
leads price, funding that mean-reverts with crowding) next to pure noise, so the learning layer has
something real to discover – and many things that only look like signal.
"""
from __future__ import annotations

import math
from collections import deque

import numpy as np

from ..data.bars import Bar
from ..data.history import History
from ..util import HOUR_MS

DEFAULT_PRICES = {"xyz:GEV": 920.5, "HMSTR": 0.000143, "xyz:EBAY": 120.9, "xyz:SHEIN": 4.708, "TNSR": 0.03113,
                  "xyz:LYTE": 19.85, "xyz:OURA": 48.62, "xyz:XBI": 143.7, "xyz:KSTR": 19.2, "xyz:BIRD": 2.343}


class _Asset:
    def __init__(self, coin: str, rng: np.random.Generator):
        self.coin = coin
        self.rng = rng
        self.px = DEFAULT_PRICES.get(coin, float(rng.uniform(1, 200)))
        self.oracle = self.px
        self.vol_d = float(rng.uniform(0.35, 1.4))          # annualised base vol
        self.drift = 0.0
        self.vol_mult = 1.0
        self.funding = 0.0000125
        self.flow_bias = 0.0
        self.spread_bps = float(rng.uniform(8, 45))
        self.depth_usd = float(rng.uniform(25_000, 150_000))
        self.oi_base = float(rng.uniform(5e4, 8e5)) / self.px
        self.oi = self.oi_base
        self.prev_day = self.px
        self.day_vol = 0.0
        self.day = 0
        self.prem = 0.0
        self.future = deque(rng.normal(0, 1, 12).tolist())   # pre-drawn shocks → order flow can lead price

    def step(self, dt_ms: int) -> tuple[float, list]:
        rng = self.rng
        dt_y = dt_ms / (365 * 24 * 3600 * 1000)
        # regime switches
        if rng.random() < dt_ms / (6 * HOUR_MS):
            self.drift = float(rng.choice([-1, 0, 0, 1]) * rng.uniform(1.5, 9.0))
        if rng.random() < dt_ms / (8 * HOUR_MS):
            self.vol_mult = float(rng.choice([0.6, 1.0, 1.0, 1.8]))
        sigma = self.vol_d * self.vol_mult
        # order flow leads price: the flow bias is a noisy preview of the next few (pre-drawn) shocks
        shock = self.future.popleft()
        self.future.append(float(rng.normal(0, 1)))
        upcoming = sum(list(self.future)[:6]) / 6
        self.flow_bias = float(np.tanh(0.9 * upcoming + rng.normal(0, 0.35)))
        jump = rng.normal(0, 6) if rng.random() < dt_ms / (10 * HOUR_MS) else 0.0
        ret = self.drift * dt_y + sigma * math.sqrt(dt_y) * (shock + jump)
        self.oracle *= math.exp(ret)
        # mark = oracle × exp(premium), premium is mean-reverting microstructure noise
        self.prem = 0.9 * self.prem + rng.normal(0, self.spread_bps / 1e4 / 6)
        self.px = self.oracle * math.exp(self.prem)
        # funding mean-reverts and reacts to crowding (recent drift)
        self.funding += 0.02 * (0.0000125 + 0.00004 * math.tanh(self.drift / 5) - self.funding) + rng.normal(0, 2e-6)
        self.oi = max(self.oi_base * 0.2, self.oi * math.exp(rng.normal(0.0, 0.002)
                                                            + 0.01 * math.log(self.oi_base / self.oi)))
        # trades: Poisson count, side biased by flow
        lam = dt_ms / 60_000 * (0.6 + 2.0 * self.vol_mult)
        trades = []
        for _ in range(int(rng.poisson(lam))):
            buy = rng.random() < 0.5 + 0.35 * self.flow_bias
            sz_usd = float(rng.lognormal(math.log(250), 1.0))
            px = self.px * (1 + (1 if buy else -1) * self.spread_bps / 2e4)
            trades.append({"buy": buy, "px": px, "sz": sz_usd / px})
            self.day_vol += sz_usd
        return ret, trades

    def book(self) -> list:
        rng = self.rng
        half = self.spread_bps / 2e4 * self.vol_mult ** 0.5
        mid = self.px
        imb = float(np.tanh(self.flow_bias * 1.5 + rng.normal(0, 0.3)))
        bids, asks = [], []
        per_level = self.depth_usd / 2 / 20
        for i in range(20):
            step = half + i * half * 0.6
            bsz = per_level * (1 + imb * 0.6) * float(rng.exponential(1.0)) / mid
            asz = per_level * (1 - imb * 0.6) * float(rng.exponential(1.0)) / mid
            bids.append({"px": f"{mid * (1 - step):.8g}", "sz": f"{max(bsz, 1e-9):.6g}", "n": 1})
            asks.append({"px": f"{mid * (1 + step):.8g}", "sz": f"{max(asz, 1e-9):.6g}", "n": 1})
        return [bids, asks]


class SyntheticMarket:
    def __init__(self, coins: list[str], bar_ms: int, seed: int = 42):
        self.rng = np.random.default_rng(seed)
        self.assets = {c: _Asset(c, np.random.default_rng(seed + i * 7919)) for i, c in enumerate(coins)}
        self.bar_ms = bar_ms
        self.t = 0

    def sync_time(self, t: int) -> None:
        self.t = t

    def calibration(self) -> dict:
        return {c: {"spread_bps": a.spread_bps, "depth_usd": a.depth_usd} for c, a in self.assets.items()}

    def history(self, start_ms: int, n_bars: int, sub_steps: int = 10) -> dict[str, History]:
        out = {}
        dt = self.bar_ms // sub_steps
        for coin, a in self.assets.items():
            bars = []
            ft, fr, pr = [], [], []
            t = start_ms - start_ms % self.bar_ms
            for _ in range(n_bars):
                o = a.px
                h = l = o
                v = 0.0
                n = 0
                for _ in range(sub_steps):
                    _, trades = a.step(dt)
                    h, l = max(h, a.px), min(l, a.px)
                    v += sum(x["sz"] for x in trades)
                    n += len(trades)
                bars.append(Bar(t, o, h, l, a.px, v, n))
                t += self.bar_ms
                if t % HOUR_MS == 0:
                    ft.append(t)
                    fr.append(a.funding)
                    pr.append(math.log(a.px / a.oracle))
            out[coin] = History(coin, "sim", bars, np.array(ft, dtype=np.int64), np.array(fr), np.array(pr))
            a.prev_day = a.px
        self.t = t
        return out

    def step(self, dt_ms: int) -> dict[str, dict]:
        self.t += dt_ms
        ev = {}
        day = self.t // (24 * HOUR_MS)
        for coin, a in self.assets.items():
            if a.day != day:
                a.day, a.day_vol, a.prev_day = day, 0.0, a.px
            _, trades = a.step(dt_ms)
            tr = [{"coin": coin, "side": "B" if x["buy"] else "A", "px": f"{x['px']:.8g}", "sz": f"{x['sz']:.6g}",
                   "time": self.t} for x in trades]
            ctx = {"markPx": a.px, "oraclePx": a.oracle, "midPx": a.px, "funding": a.funding,
                   "premium": math.log(a.px / a.oracle), "openInterest": a.oi, "dayNtlVlm": a.day_vol,
                   "prevDayPx": a.prev_day,
                   "impactPxs": [a.px * (1 - a.spread_bps / 1e4), a.px * (1 + a.spread_bps / 1e4)]}
            ev[coin] = {"book": a.book(), "trades": tr, "ctx": ctx}
        return ev
