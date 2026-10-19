"""Event-driven walk-forward backtest that runs the *same* engine and brain as live trading."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import numpy as np

from ..config import Config
from ..data.bars import arrays_from_bars
from ..data.history import History
from ..engine.engine import Engine
from ..exchange.meta import MarketSpec
from ..features.pipeline import align_leader, compute_features, leader_of, row
from ..learning.brain import Brain
from ..util import HOUR_MS, INTERVAL_MS

log = logging.getLogger("multbot.backtest")


@dataclass
class BacktestResult:
    equity: list
    trades: list
    account: dict
    counters: dict
    rejects: dict
    start_t: int
    end_t: int
    train_end_t: int
    elapsed_s: float
    journal: list = field(default_factory=list)
    bars: int = 0


def prepare_features(history: dict[str, History], specs: dict[str, MarketSpec], interval: str,
                     use_lead: bool = True) -> dict[str, dict]:
    out = {}
    ims = INTERVAL_MS[interval]
    arrays = {c: arrays_from_bars(h.bars) for c, h in history.items() if h.bars}
    for coin, a in arrays.items():
        h = history[coin]
        fr, pr = h.funding_aligned(a["t"])
        lead_coin = leader_of(coin, specs[coin].asset_class, arrays) if use_lead and coin in specs else None
        lead = align_leader(a["t"], arrays[lead_coin]["t"], arrays[lead_coin]["c"]) if lead_coin else None
        f = compute_features(a, ims, fr, pr, lead)
        out[coin] = {"a": a, "f": f, "hist": h}
    return out


def _funding_at(h: History, hour_ms: int) -> float | None:
    if len(h.funding_t) == 0:
        return None
    i = int(np.searchsorted(h.funding_t, hour_ms - 5 * 60_000))
    if i < len(h.funding_t) and abs(int(h.funding_t[i]) - hour_ms) <= 5 * 60_000:
        return float(h.funding_rate[i])
    return None


def run_backtest(cfg: Config, specs: dict[str, MarketSpec], history: dict[str, History], brain: Brain,
                 calib: dict | None = None, train_frac: float | None = None, trade: bool = True,
                 skip_learned: bool = False, progress=None, prepared: dict | None = None) -> BacktestResult:
    t0 = time.time()
    interval = cfg.signal.interval
    ims = INTERVAL_MS[interval]
    data = prepared or prepare_features(history, specs, interval, cfg.signal.use_lead_lag)
    engine = Engine(cfg, specs, brain, store=None, run="backtest", mode="backtest", calib=calib, journal_size=4000)
    times = sorted({int(t) for d in data.values() for t in d["a"]["t"]})
    if not times:
        raise ValueError("keine Historie für den Backtest")
    tf = cfg.research.train_frac if train_frac is None else train_frac
    train_end_t = times[min(int(len(times) * tf), len(times) - 1)] if tf > 0 else times[0]
    index = {c: {int(t): i for i, t in enumerate(d["a"]["t"])} for c, d in data.items()}
    learned_until = dict(brain.trained_until) if skip_learned else {}
    spread = {c: float((calib or {}).get(c, {}).get("spread_bps", cfg.execution.synthetic_spread_bps)) for c in data}
    n_steps = len(times)
    for step, t in enumerate(times):
        t_close = t + ims
        crosses_hour = (t_close % HOUR_MS) == 0 or (t // HOUR_MS) != (t_close // HOUR_MS)
        hour_mark = (t_close // HOUR_MS) * HOUR_MS
        for coin, d in data.items():
            i = index[coin].get(t)
            if i is None:
                continue
            a, f = d["a"], d["f"]
            o, h, l, c = a["o"][i], a["h"][i], a["l"][i], a["c"][i]
            engine.on_price(coin, float(c), t_close, hi=float(h), lo=float(l), open_px=float(o))
            if crosses_hour and coin in engine.account.positions:
                rate = _funding_at(d["hist"], hour_mark)
                if rate is None:
                    rate = float(f["funding_h"][i])
                engine.on_funding(coin, rate, float(c), t_close)
            learn = not (skip_learned and t_close <= learned_until.get(coin, 0))
            r = row(f, i)
            r["spread_bps"] = spread[coin]
            engine.on_bar_close(coin, t_close, r, i + 1, trade=trade and t >= train_end_t, learn=learn)
        engine.mark_equity(t_close)
        if progress and step % 250 == 0:
            progress(step / n_steps)
    # flatten at the end so all PnL is realised
    engine.close_all(times[-1] + ims, "Backtest-Ende")
    engine.mark_equity(times[-1] + ims)
    if progress:
        progress(1.0)
    return BacktestResult(
        equity=list(engine.equity_curve), trades=list(engine.trades), account=engine.account.summary(engine.last_px),
        counters=dict(engine.counters), rejects=dict(engine.reject_reasons), start_t=times[0] + ims,
        end_t=times[-1] + ims, train_end_t=train_end_t + ims, elapsed_s=time.time() - t0,
        journal=list(engine.journal)[-1000:], bars=n_steps,
    )
