"""Alpha lab: fast, vectorised edge research over the whole universe, net of real costs.

Every hypothesis is a score per market and hour. Two trade models are evaluated for each holding period H:

* **hold** – enter at the close, exit H hours later (pure signal quality after fees, spread, impact and the
  funding paid while holding). Entries on *every* hour (overlapping books), so no entry hour is privileged.
* **max-lev** – the bot's reality: 100 USD margin × the market's maximum leverage, stop at 60 % of the
  liquidation distance, checked against hourly highs / lows; exit at the stop or after H hours. Loss capped at
  the margin (isolated).

The history is split in two halves (A = first, B = second). A hypothesis only counts as *consistent* if it is
positive after costs in both halves – with dozens of tests, a few will pass by luck, which the report states.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np

from ..data.bars import arrays_from_bars
from ..data.history import History
from ..exchange.meta import MarketSpec

log = logging.getLogger("multbot.lab")
HOUR = 3_600_000


class Panel:
    """Markets × hours matrices (close, high, low, funding, premium) on a common time grid."""

    def __init__(self, history: dict[str, History], specs: dict[str, MarketSpec], calib: dict | None = None,
                 min_bars: int = 300, position_margin: float = 100.0):
        calib = calib or {}
        arrays = {c: arrays_from_bars(h.bars) for c, h in history.items() if len(h.bars) >= min_bars and c in specs}
        if len(arrays) < 4:
            raise ValueError("zu wenige Märkte mit ausreichender Historie für das Alpha-Labor")
        self.coins = sorted(arrays)
        t_all = np.unique(np.concatenate([a["t"] for a in arrays.values()]))
        self.step = int(np.median(np.diff(t_all)))
        self.t = np.arange(t_all[0], t_all[-1] + 1, self.step, dtype=np.int64)
        T, N = len(self.t), len(self.coins)
        self.c = np.full((T, N), np.nan)
        self.h = np.full((T, N), np.nan)
        self.l = np.full((T, N), np.nan)
        self.fund = np.zeros((T, N))
        self.prem = np.zeros((T, N))
        for j, coin in enumerate(self.coins):
            a = arrays[coin]
            idx = ((a["t"] - self.t[0]) // self.step).astype(int)
            ok = (idx >= 0) & (idx < T)
            self.c[idx[ok], j], self.h[idx[ok], j], self.l[idx[ok], j] = a["c"][ok], a["h"][ok], a["l"][ok]
            fr, pr = history[coin].funding_aligned(self.t)
            self.fund[:, j], self.prem[:, j] = fr, pr
        for j in range(N):   # forward-fill inside a market's life (no trades = unchanged price)
            col, hi, lo = self.c[:, j], self.h[:, j], self.l[:, j]
            first = int(np.argmax(~np.isnan(col)))
            for i in range(first + 1, T):
                if np.isnan(col[i]):
                    col[i] = hi[i] = lo[i] = col[i - 1]
        self.alive = ~np.isnan(self.c)
        self.logc = np.log(self.c)
        self.cls = np.array([specs[c].asset_class for c in self.coins])
        self.lev = np.array([specs[c].leverage for c in self.coins], dtype=float)
        spread = np.array([float(calib.get(c, {}).get("spread_bps", 5.0)) for c in self.coins]) / 1e4
        depth = np.array([max(float(calib.get(c, {}).get("depth_usd", 50_000.0)) / 2, 1_000.0) for c in self.coins])
        maker = np.array([specs[c].maker_fee for c in self.coins])
        taker = np.array([specs[c].taker_fee for c in self.coins])
        impact = np.minimum(0.01 * position_margin * self.lev / depth, 0.05)
        # maker entry at the touch, taker exit: fees + exit impact + 1 bp slippage (the spread cancels: the entry
        # is half a spread better than the close, the exit half a spread worse – see execution.round_trip_cost)
        self.cost = maker + taker + impact + 1e-4
        self.spread = spread
        self.bars_per_hour = HOUR / self.step
        r1 = np.diff(self.logc, axis=0, prepend=np.nan)
        self.r1 = np.where(np.isfinite(r1), r1, 0.0)
        self.vol = _ewm_std(self.r1, 96)
        self.market = np.nanmean(np.where(self.alive, self.r1, np.nan), axis=1, keepdims=True)

    # ── building blocks for hypotheses ──────────────────────────────────
    def past(self, k: int) -> np.ndarray:
        out = np.full_like(self.logc, np.nan)
        out[k:] = self.logc[k:] - self.logc[:-k]
        return out

    def past_z(self, k: int) -> np.ndarray:
        return self.past(k) / (self.vol * math.sqrt(k))

    def resid_z(self, k: int) -> np.ndarray:
        cs = np.cumsum(self.r1 - self.market, axis=0)
        out = np.full_like(cs, np.nan)
        out[k:] = cs[k:] - cs[:-k]
        return out / (self.vol * math.sqrt(k))

    def zscore_cols(self, x: np.ndarray) -> np.ndarray:
        return x / (np.nanstd(x, axis=0, keepdims=True) + 1e-12)

    def ema_gap(self, fast: int, slow: int) -> np.ndarray:
        out = np.full_like(self.c, np.nan)
        af, as_ = 2 / (fast + 1), 2 / (slow + 1)
        f = s = np.full(self.c.shape[1], np.nan)
        for i in range(len(self.c)):
            x = self.logc[i]
            f = np.where(np.isnan(f), x, f + (x - f) * af)
            s = np.where(np.isnan(s), x, s + (x - s) * as_)
            out[i] = f - s
        return out / (self.vol * math.sqrt(slow))

    def hour_of_day(self) -> np.ndarray:
        return ((self.t // HOUR) % 24)[:, None] * np.ones((1, len(self.coins)))

    def weekday(self) -> np.ndarray:
        return (((self.t // (24 * HOUR)) + 3) % 7)[:, None] * np.ones((1, len(self.coins)))   # 0 = Monday


def _ewm_std(x: np.ndarray, span: int) -> np.ndarray:
    lam = 1 - 2 / (span + 1)
    out = np.zeros_like(x)
    m2 = np.full(x.shape[1], np.nan)
    for i in range(len(x)):
        xi = x[i] ** 2
        m2 = np.where(np.isnan(m2), xi, lam * m2 + (1 - lam) * xi)
        out[i] = np.sqrt(m2)
    return np.maximum(out, 1e-5)


def _sides(P: Panel, score: np.ndarray, valid: np.ndarray, thr: float, top: int | None) -> np.ndarray:
    if top:
        side = np.zeros_like(score)
        cnt = valid.sum(axis=1)
        order = np.argsort(np.where(valid, score, np.inf), axis=1)
        for i in np.nonzero(cnt >= 2 * top)[0]:
            o = order[i, :cnt[i]]
            side[i, o[:top]] = -1
            side[i, o[cnt[i] - top:cnt[i]]] = 1
        return side
    s = np.where(valid, np.nan_to_num(score), 0.0)
    return np.where(np.abs(s) > thr, np.sign(s), 0.0)


def evaluate(P: Panel, score: np.ndarray, H: int, thr: float = 0.0, top: int | None = None,
             classes: list[str] | None = None, max_lev_model: bool = False, stop_frac: float = 0.6) -> dict:
    """Both halves' statistics of one hypothesis (see module docstring)."""
    T, N = score.shape
    valid = np.isfinite(score) & P.alive
    if classes:
        valid &= np.isin(P.cls, classes)[None, :]
    side = _sides(P, score, valid, thr, top)
    side[T - H:] = 0
    per_bar_f = P.fund / P.bars_per_hour
    cs = np.cumsum(np.vstack([np.zeros((1, N)), per_bar_f]), axis=0)
    fund_long = np.zeros((T, N))
    fund_long[:T - H] = cs[1 + H:T + 1] - cs[1:T + 1 - H]
    if not max_lev_model:
        fr = np.zeros((T, N))
        fr[:T - H] = P.logc[H:] - P.logc[:-H]
        move = side * np.nan_to_num(fr)
        lev = np.ones((1, N))
    else:
        lev = P.lev[None, :]
        stop = np.broadcast_to(stop_frac / (2.0 * lev), (T, N))
        move = np.zeros((T, N))
        done = np.zeros((T, N), bool)
        for k in range(1, H + 1):
            hi = np.full((T, N), np.nan)
            lo = np.full((T, N), np.nan)
            hi[:T - k], lo[:T - k] = P.h[k:], P.l[k:]
            adverse = np.nan_to_num(np.where(side > 0, lo / P.c - 1, 1 - hi / P.c))
            hit = ~done & (side != 0) & (adverse <= -stop)
            move[hit] = -stop[hit]
            done |= hit
        end = ~done & (side != 0)
        fr = np.zeros((T, N))
        fr[:T - H] = P.c[H:] / P.c[:-H] - 1
        move[end] = (side * np.nan_to_num(fr))[end]
    net = move - side * fund_long - np.abs(side) * P.cost[None, :]
    usd = np.maximum(100.0 * net * lev, -100.0)
    traded = side != 0
    day = P.t // (24 * HOUR)
    out = {}
    cut = T // 2
    for part, rows in (("A", slice(0, cut)), ("B", slice(cut, T))):
        m = traded[rows]
        n = int(m.sum())
        if n < 30:
            out[part] = {"n": n}
            continue
        nn, uu, d = net[rows], usd[rows], day[rows]
        dm: dict[int, list] = {}
        for i in np.nonzero(m.any(axis=1))[0]:
            dm.setdefault(int(d[i]), []).extend(nn[i][m[i]].tolist())
        daily = np.array([np.mean(v) for v in dm.values()])
        t = (daily.mean() / (daily.std(ddof=1) / math.sqrt(len(daily))) / math.sqrt(max(1.0, H / 24 / P.bars_per_hour))
             if len(daily) > 2 and daily.std() > 0 else 0.0)
        out[part] = {"n": int(round(n / H)), "net_bps": float(nn[m].mean() * 1e4), "usd": float(uu[m].mean()),
                     "win": float((nn[m] > 0).mean()), "t": float(t)}
    out["consistent"] = all("usd" in out[p] and out[p]["usd"] > 0 and out[p]["net_bps"] > 0 for p in "AB")
    return out


@dataclass
class Hypothesis:
    key: str
    family: str
    name: str
    why: str
    score: Callable[[Panel], np.ndarray]
    thr: float = 0.0
    top: int | None = None
    classes: list[str] | None = None


EQUITY = ["equity", "etf", "index"]


def hypotheses() -> list[Hypothesis]:
    """Pre-registered list (decided before looking at results, to keep the multiple-testing count honest)."""
    hs: list[Hypothesis] = []
    for k in (4, 24, 72, 168):
        hs.append(Hypothesis(f"tsmom_{k}", "Momentum", f"Zeitreihen-Momentum {k} h",
                             f"long, wenn die letzten {k} h stark gestiegen sind (z > 1), short umgekehrt",
                             lambda P, k=k: P.past_z(k), thr=1.0))
        hs.append(Hypothesis(f"tsrev_{k}", "Reversion", f"Zeitreihen-Reversion {k} h",
                             f"gegen die Bewegung der letzten {k} h (z > 1)", lambda P, k=k: -P.past_z(k), thr=1.0))
        hs.append(Hypothesis(f"xsmom_{k}", "Querschnitt", f"Querschnitts-Momentum {k} h",
                             f"long die 3 stärksten, short die 3 schwächsten Märkte der letzten {k} h",
                             lambda P, k=k: P.past_z(k), top=3))
        hs.append(Hypothesis(f"resid_{k}", "Querschnitt", f"Residual-Reversion {k} h",
                             f"gegen die Abweichung vom Gesamtmarkt der letzten {k} h (Top/Flop 3)",
                             lambda P, k=k: -P.resid_z(k), top=3))
    hs += [
        Hypothesis("trend_ema", "Momentum", "EMA-Trend 24/100 h", "Abstand schnelle/langsame EMA, z > 1",
                   lambda P: P.ema_gap(24, 100), thr=1.0),
        Hypothesis("tail_rev", "Reversion", "Extrem-Bewegung zurück (1 h, z > 3)",
                   "nach > 3σ-Stunden (Liquidationskaskaden) dagegen", lambda P: -P.past_z(1), thr=3.0),
        Hypothesis("carry", "Carry", "Funding-Carry (z > 1,5)", "die Seite nehmen, die Funding bekommt",
                   lambda P: -P.zscore_cols(P.fund), thr=1.5),
        Hypothesis("carry_xs", "Carry", "Funding-Carry Querschnitt", "long niedrigstes, short höchstes Funding",
                   lambda P: -P.fund, top=3),
        Hypothesis("premium", "Carry", "Prämien-Reversion (z > 1,5)", "Mark über Oracle → short, darunter → long",
                   lambda P: -P.zscore_cols(P.prem), thr=1.5),
        Hypothesis("eq_mom", "Aktien-Perps", "Aktien: Momentum 72 h", "nur xyz-Aktien/ETFs/Indizes",
                   lambda P: P.past_z(72), thr=1.0, classes=EQUITY),
        Hypothesis("eq_weekend", "Aktien-Perps", "Aktien: Wochenende long",
                   "Fr 21 UTC long, Börse zu – driftet der Perp?",
                   lambda P: np.where((P.weekday() == 4) & (P.hour_of_day() == 21), 1.0, 0.0), thr=0.5,
                   classes=EQUITY),
        Hypothesis("beta", "Referenz", "Immer long (Markt-Beta)", "Referenz: misst nur den Markttrend des Zeitraums",
                   lambda P: np.ones_like(P.c), thr=0.5),
    ]
    return hs


def run_lab(history: dict[str, History], specs: dict[str, MarketSpec], calib: dict | None = None,
            horizons_h: tuple = (4, 12, 24, 48), progress=None, position_margin: float = 100.0) -> dict:
    t0 = time.time()
    P = Panel(history, specs, calib, position_margin=position_margin)
    bph = P.bars_per_hour
    hs = hypotheses()
    rows = []
    total = len(hs) * len(horizons_h)
    done = 0
    for h in hs:
        score = h.score(P)
        for H_h in horizons_h:
            H = max(1, int(round(H_h * bph)))
            hold = evaluate(P, score, H, h.thr, h.top, h.classes)
            path = evaluate(P, score, H, h.thr, h.top, h.classes, max_lev_model=True)
            rows.append({"key": h.key, "family": h.family, "name": h.name, "why": h.why, "hours": H_h,
                         "hold": hold, "maxlev": path, "consistent": hold["consistent"] and path["consistent"]})
            done += 1
            if progress:
                progress(done / total)
    n_tests = len(rows)
    n_ok = sum(r["consistent"] for r in rows if r["key"] != "beta")
    beta_ok = any(r["consistent"] for r in rows if r["key"] == "beta")
    return {
        "generated": int(time.time() * 1000), "elapsed_s": round(time.time() - t0, 1),
        "markets": len(P.coins), "bars": len(P.t), "interval_min": P.step // 60_000,
        "start": int(P.t[0]), "end": int(P.t[-1]), "split": int(P.t[len(P.t) // 2]),
        "classes": {c: int((P.cls == c).sum()) for c in sorted(set(P.cls.tolist()))},
        "cost_bps_median": float(np.median(P.cost) * 1e4), "rows": rows, "n_tests": n_tests,
        "n_consistent": n_ok, "expected_by_luck": round(0.25 * (n_tests - len(horizons_h)), 1),
        "beta_consistent": beta_ok,
    }


async def run_lab_live(cfg, top: int | None = None, bars: int = 5000, progress=None,
                       out_name: str = "lab_latest.json") -> dict:
    """Fetch hourly history (+ funding) for the most liquid markets, calibrate costs, run the lab, save JSON."""
    import asyncio
    import json

    from ..data.history import fetch_all
    from ..exchange.hyperliquid import HLRest
    from ..exchange.meta import build_specs
    from .report import _default, calibrate_costs, select_markets

    rest = HLRest(cfg.api_url)
    try:
        metas, ctxs = {}, {}
        for dex in cfg.dexes:
            metas[dex], ctxs[dex] = await rest.meta_and_ctxs(dex)
        specs = select_markets(build_specs(cfg, metas, ctxs), top or cfg.research.lab_markets)
        log.info("Alpha-Labor: %d Märkte, %d Stunden-Bars", len(specs), bars)
        fetched = [0]

        async def fetch():
            return await fetch_all(cfg, rest, "1h", bars, coins=list(specs))
        task = asyncio.create_task(fetch())
        while not task.done():   # history download dominates the first run (funding pages); show progress
            await asyncio.sleep(2)
            n = sum(1 for c in specs if cfg.data_path("history", f"{c.replace(':', '_')}_funding.json").exists())
            fetched[0] = n
            if progress:
                progress(0.8 * n / max(len(specs), 1))
        history = task.result()
        calib = await calibrate_costs(rest, list(specs))
    finally:
        await rest.close()
    rep = await asyncio.to_thread(run_lab, history, specs, calib, (4, 12, 24, 48),
                                  (lambda x: progress(0.8 + 0.2 * x)) if progress else None,
                                  cfg.account.position_margin_usd)
    path = cfg.data_path("research", out_name)
    path.write_text(json.dumps(rep, default=_default))
    return rep


def print_lab(rep: dict) -> None:
    from ..util import fmt_ts
    print(f"\n══════════════ MULT Q2 ALPHA-LABOR ══════════════")
    print(f"{rep['markets']} Märkte · {rep['bars']} Stunden · {fmt_ts(rep['start'])} → {fmt_ts(rep['end'])} · "
          f"Hälfte A bis {fmt_ts(rep['split'])} · Kosten Median {rep['cost_bps_median']:.1f} bps")
    print(f"{'Hypothese':<40}{'H':>4} | {'hold A':>9}{'hold B':>9} | {'maxLev A $':>11}{'maxLev B $':>11}  ok")
    for r in rep["rows"]:
        h, m = r["hold"], r["maxlev"]
        f = lambda x, k: "-" if k not in x else f"{x[k]:+.1f}"
        print(f"{r['name'][:39]:<40}{r['hours']:>3}h | {f(h['A'], 'net_bps'):>9}{f(h['B'], 'net_bps'):>9} | "
              f"{f(m['A'], 'usd'):>11}{f(m['B'], 'usd'):>11}  {'✓' if r['consistent'] else ''}")
    print(f"\n{rep['n_consistent']} von {rep['n_tests']} Tests in beiden Hälften positiv (hold + maxLev). "
          f"Durch Zufall erwartbar: bis ≈ {rep['expected_by_luck']}.")
