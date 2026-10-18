"""Runners: plumbing between a market data source and the engine.

* ``LiveRunner`` – Hyperliquid WebSocket + REST, bars built from the mark price (what HL uses for
  liquidations and stop triggers), real order books for fills.
* ``SimRunner``  – synthetic market with an accelerated virtual clock (offline demo / testing).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque

import numpy as np

from ..config import Config
from ..data.bars import Bar, BarSeries
from ..data.history import History, fetch_all
from ..data.store import Store
from ..exchange.hyperliquid import HLRest, HLWebSocket
from ..exchange.meta import MarketSpec, build_specs, offline_specs
from ..features.micro import MicroState
from ..features.pipeline import MICRO_KEYS, compute_features, row
from ..learning.brain import Brain
from ..research.backtest import prepare_features, run_backtest
from ..research.report import build_report, calibrate_costs
from ..util import HOUR_MS, INTERVAL_MS, now_ms
from .engine import Engine
from .sim import SyntheticMarket

log = logging.getLogger("multbot.runner")

FEATURE_WINDOW = 700


class BaseRunner:
    kind = "base"

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.bar_ms = INTERVAL_MS[cfg.signal.interval]
        self.specs: dict[str, MarketSpec] = {}
        self.micro: dict[str, MicroState] = {}
        self.series: dict[str, BarSeries] = {}
        self.fund: dict[str, deque] = {}
        self.prem: dict[str, deque] = {}
        self.cur: dict[str, dict | None] = {}
        self.engine: Engine | None = None
        self.brain: Brain | None = None
        self.store: Store | None = None
        self.calib: dict = {}
        self.status = {"phase": "init", "msg": "Initialisiere …", "progress": 0.0}
        self.pretrain: dict | None = None
        self.started_ms = now_ms()
        self.run_id = self.kind
        self.last_hour = 0
        self.last_equity_mark = 0
        self.last_persist = time.time()
        self._stop = asyncio.Event()
        self.tasks: list[asyncio.Task] = []
        self.feed_stats = {"ctx": 0, "book": 0, "trades": 0, "bars": 0}

    # ── time ──────────────────────────────────────────────────────────────
    def now(self) -> int:
        return now_ms()

    def set_status(self, phase: str, msg: str, progress: float | None = None) -> None:
        self.status = {"phase": phase, "msg": msg, "progress": self.status.get("progress", 0.0)
                       if progress is None else progress}
        log.info("[%s] %s", phase, msg)

    # ── shared setup ──────────────────────────────────────────────────────
    def _init_state(self, specs: dict[str, MarketSpec]) -> None:
        self.specs = specs
        for c in specs:
            self.micro[c] = MicroState(c)
            self.series[c] = BarSeries(maxlen=3000)
            self.fund[c] = deque(maxlen=3000)
            self.prem[c] = deque(maxlen=3000)
            self.cur[c] = None
        self.store = Store(self.cfg.data_path(f"{self.run_id}.db"))
        self.brain = Brain(self.cfg, list(specs))
        self.brain.load_file(self.cfg.data_path(f"brain_{self.run_id}.json"))

    def _bootstrap(self, history: dict[str, History]) -> None:
        for coin, h in history.items():
            if not h.bars:
                continue
            ts = np.array([b.t for b in h.bars], dtype=np.int64)
            fr, pr = h.funding_aligned(ts)
            s = self.series[coin]
            for b, f_, p_ in zip(h.bars, fr, pr):
                if s.upsert(b):
                    self.fund[coin].append(float(f_))
                    self.prem[coin].append(float(p_))
            last = h.bars[-1]
            self.micro[coin].mark = self.micro[coin].mark or last.c

    def _pretrain(self, history: dict[str, History]) -> None:
        if not self.cfg.learning.pretrain_on_history:
            return
        self.set_status("pretrain", "Vortraining auf Historie (Walk-Forward-Backtest) …", 0.0)

        def prog(x):
            self.status["progress"] = round(x, 3)

        prepared = prepare_features(history, self.specs, self.cfg.signal.interval)
        res = run_backtest(self.cfg, self.specs, history, self.brain, self.calib, None, True, True, prog, prepared)
        rep = build_report(self.cfg, self.specs, history, res, self.brain, self.calib, label="pretrain")
        self.pretrain = rep
        try:
            self.cfg.data_path("research", f"pretrain_{self.run_id}.json").write_text(json.dumps(rep, default=_jd))
        except OSError as e:
            log.warning("Vortraining-Report nicht gespeichert: %s", e)
        self.brain.save(self.cfg.data_path(f"brain_{self.run_id}.json"))
        log.info("Vortraining fertig: %d Trades im Backtest, Brain n=%d", len(res.trades), self.brain.n_resolved)

    def _make_engine(self) -> None:
        self.engine = Engine(self.cfg, self.specs, self.brain, self.store, run=self.run_id, mode=self.kind,
                             micro=self.micro, calib=self.calib)
        state = self.store.get_kv(f"engine:{self.run_id}")
        if state:
            self.engine.load_state(state)
            log.info("Konto wiederhergestellt: Epoche %d, Equity %.2f USD, %d offene Positionen",
                     self.engine.account.epoch, self.engine.equity(), len(self.engine.account.positions))
        else:
            self.engine.log_event(self.now(), "", "INFO",
                                  f"Neues Papierkonto mit {self.cfg.account.starting_balance:.2f} USD – "
                                  f"immer maximaler Hebel: " + ", ".join(f"{c} {s.leverage}x" for c, s in self.specs.items()))
        for coin, s in self.series.items():
            if len(s):
                self.engine.last_px.setdefault(coin, s.last().c)

    # ── data feed handlers ────────────────────────────────────────────────
    def feed_mark(self, coin: str, px: float, t: int) -> None:
        if px <= 0 or coin not in self.cur:
            return
        bt = t - t % self.bar_ms
        cur = self.cur[coin]
        if cur is None or bt > cur["t"]:
            if cur is not None and bt > cur["t"]:
                self._finalize(coin, cur, t)
            o = self.series[coin].last().c if cur is None and len(self.series[coin]) else px
            if cur is not None:
                o = cur["c"]
            self.cur[coin] = cur = {"t": bt, "o": o, "h": max(o, px), "l": min(o, px), "c": px, "v": 0.0, "n": 0}
        cur["h"] = max(cur["h"], px)
        cur["l"] = min(cur["l"], px)
        cur["c"] = px
        if self.engine:
            self.engine.on_price(coin, px, t)

    def feed_trades(self, coin: str, trades: list[dict]) -> None:
        m = self.micro.get(coin)
        if not m:
            return
        m.update_trades(trades)
        cur = self.cur.get(coin)
        for tr in trades:
            if cur is not None and int(tr["time"]) >= cur["t"]:
                cur["v"] += float(tr["sz"])
                cur["n"] += 1
            if self.engine:
                self.engine.on_trade(coin, float(tr["px"]), 1 if tr.get("side") == "B" else -1, int(tr["time"]))
        self.feed_stats["trades"] += len(trades)

    def feed_ctx(self, coin: str, ctx: dict, t: int) -> None:
        m = self.micro.get(coin)
        if not m:
            return
        m.update_ctx(ctx, t)
        self.feed_stats["ctx"] += 1
        if m.mark > 0:
            self.feed_mark(coin, m.mark, t)

    def feed_book(self, coin: str, levels, t: int) -> None:
        m = self.micro.get(coin)
        if m:
            m.update_book(levels, t)
            self.feed_stats["book"] += 1

    # ── bar closing / features ────────────────────────────────────────────
    def _finalize(self, coin: str, cur: dict, t: int) -> None:
        bar = Bar(cur["t"], cur["o"], cur["h"], cur["l"], cur["c"], cur["v"], cur["n"])
        m = self.micro[coin]
        if self.series[coin].upsert(bar):
            self.fund[coin].append(m.funding_h)
            self.prem[coin].append(m.premium)
        self.feed_stats["bars"] += 1
        if not self.engine:
            return
        frow = self.feature_row(coin, t)
        self.engine.on_bar_close(coin, cur["t"] + self.bar_ms, frow, len(self.series[coin]))

    def feature_row(self, coin: str, t: int) -> dict:
        a = self.series[coin].arrays(last=FEATURE_WINDOW)
        n = len(a["t"])
        fr = np.array(list(self.fund[coin])[-n:], dtype=float)
        pr = np.array(list(self.prem[coin])[-n:], dtype=float)
        if len(fr) < n:
            fr = np.concatenate([np.zeros(n - len(fr)), fr])
            pr = np.concatenate([np.zeros(n - len(pr)), pr])
        f = compute_features(a, self.bar_ms, fr, pr, self.specs[coin].is_equity)
        r = row(f)
        mf = self.micro[coin].features(t)
        for k in MICRO_KEYS:
            r[k] = mf.get(k, 0.0)
        if self.micro[coin].ctx_ms:
            r["premium_bps"] = mf["premium_bps"]
            r["funding_h"] = mf["funding_h"]
        return r

    def clock(self, t: int, grace_ms: int = 1500) -> None:
        """Close due bars (also for silent markets) and settle hourly funding."""
        for coin, cur in self.cur.items():
            if cur is None:
                last = self.series[coin].last()
                if last is None:
                    continue
                cur = self.cur[coin] = {"t": last.t + self.bar_ms, "o": last.c, "h": last.c, "l": last.c,
                                        "c": last.c, "v": 0.0, "n": 0}
            while t >= cur["t"] + self.bar_ms + grace_ms:
                self._finalize(coin, cur, t)
                px = cur["c"]
                cur = self.cur[coin] = {"t": cur["t"] + self.bar_ms, "o": px, "h": px, "l": px, "c": px,
                                        "v": 0.0, "n": 0}
        hour = t // HOUR_MS
        if self.engine and self.last_hour and hour > self.last_hour:
            for coin in list(self.engine.account.positions):
                m = self.micro[coin]
                self.engine.on_funding(coin, m.funding_h, m.oracle or m.mark, hour * HOUR_MS)
        self.last_hour = hour
        if self.engine and t - self.last_equity_mark >= 10_000:
            self.last_equity_mark = t
            self.engine.mark_equity(t)

    # ── persistence ───────────────────────────────────────────────────────
    def persist(self, force: bool = False) -> None:
        if not (self.engine and self.store):
            return
        if not force and time.time() - self.last_persist < self.cfg.learning.persist_every_s:
            return
        self.last_persist = time.time()
        try:
            self.brain.save(self.cfg.data_path(f"brain_{self.run_id}.json"))
            self.store.set_kv(f"engine:{self.run_id}", self.engine.state_dict())
            snap = self.brain.snapshot(light=True)
            snap.pop("weights", None)
            self.store.add_learning(self.run_id, self.now(), snap)
            self.store.commit()
        except Exception as e:  # noqa: BLE001 – never crash the loop on persistence
            log.warning("Speichern fehlgeschlagen: %s", e)

    # ── control from the dashboard ────────────────────────────────────────
    def control(self, action: str, coin: str | None = None) -> str:
        e = self.engine
        if not e:
            return "Engine noch nicht bereit"
        t = self.now()
        if action == "pause":
            e.manual_pause = True
            e.log_event(t, "", "INFO", "Neue Einstiege pausiert (Dashboard)")
            return "pausiert"
        if action == "resume":
            e.manual_pause = False
            e.paused_until = 0
            e.log_event(t, "", "INFO", "Handel fortgesetzt (Dashboard)")
            return "fortgesetzt"
        if action == "flatten":
            if coin:
                e._cancel(coin, t, "Dashboard")
                e._close(coin, e.last_px.get(coin, 0), "Manuell geschlossen", t)
            else:
                e.close_all(t)
            return "geschlossen"
        if action == "reset":
            e.close_all(t, "Reset")
            e.account.new_epoch(t, e.equity())
            e.log_event(t, "", "INFO", f"Konto zurückgesetzt → Epoche {e.account.epoch} mit "
                        f"{self.cfg.account.starting_balance:.2f} USD (Lernstand bleibt erhalten)")
            return "zurückgesetzt"
        return f"unbekannte Aktion {action}"

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        raise NotImplementedError

    def info(self) -> dict:
        return {"kind": self.kind, "run": self.run_id, "status": self.status, "started": self.started_ms,
                "feed": self.feed_stats, "interval": self.cfg.signal.interval, "now": self.now()}


class LiveRunner(BaseRunner):
    kind = "live"

    def __init__(self, cfg: Config):
        super().__init__(cfg)
        self.rest: HLRest | None = None
        self.ws: HLWebSocket | None = None

    async def setup(self) -> None:
        self.set_status("meta", "Lade Hyperliquid-Meta (Hebel, Gebühren, Größen) …")
        self.rest = HLRest(self.cfg.api_url)
        metas, ctxs = {}, {}
        for dex in self.cfg.dexes:
            metas[dex], ctxs[dex] = await self.rest.meta_and_ctxs(dex)
        self._init_state(build_specs(self.cfg, metas))
        self._apply_ctxs(metas, ctxs)
        self.set_status("history", "Lade Kerzen- und Funding-Historie …")
        history = await fetch_all(self.cfg, self.rest, self.cfg.signal.interval, self.cfg.learning.history_bars)
        self.calib = await calibrate_costs(self.rest, list(self.specs))
        self._bootstrap(history)
        await asyncio.to_thread(self._pretrain, history)
        self._make_engine()
        self.set_status("live", "Live – WebSocket-Daten, simulierte Ausführung", 1.0)

    def _apply_ctxs(self, metas: dict, ctxs: dict) -> None:
        t = self.now()
        for dex, meta in metas.items():
            for u, ctx in zip(meta["universe"], ctxs[dex]):
                if u["name"] in self.micro:
                    self.feed_ctx(u["name"], ctx, t)

    def subscriptions(self) -> list[dict]:
        subs = []
        for c in self.specs:
            subs += [{"type": "l2Book", "coin": c}, {"type": "trades", "coin": c},
                     {"type": "activeAssetCtx", "coin": c}]
        return subs

    async def on_ws(self, channel: str, data) -> None:
        t = self.now()
        if channel == "l2Book":
            self.feed_book(data["coin"], data.get("levels"), int(data.get("time", t)))
        elif channel == "trades":
            if data:
                self.feed_trades(data[0]["coin"], data)
        elif channel in ("activeAssetCtx", "activeSpotAssetCtx"):
            self.feed_ctx(data["coin"], data.get("ctx", {}), t)

    async def _clock_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.clock(self.now())
                self.persist()
            except Exception:  # noqa: BLE001
                log.exception("Fehler im Takt-Loop")
            await asyncio.sleep(1.0)

    async def _ctx_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(60)
            try:
                metas, ctxs = {}, {}
                for dex in self.cfg.dexes:
                    metas[dex], ctxs[dex] = await self.rest.meta_and_ctxs(dex)
                self._apply_ctxs(metas, ctxs)
            except Exception as e:  # noqa: BLE001
                log.warning("Kontext-Refresh fehlgeschlagen: %s", e)

    async def run(self) -> None:
        try:
            await self.setup()
        except Exception as e:
            self.set_status("error", f"Start fehlgeschlagen: {e}")
            log.exception("Setup fehlgeschlagen")
            return
        self.ws = HLWebSocket(self.cfg.ws_url, self.subscriptions(), self.on_ws)
        self.tasks = [asyncio.create_task(self.ws.run()), asyncio.create_task(self._clock_loop()),
                      asyncio.create_task(self._ctx_loop())]
        await self._stop.wait()
        self.ws.stop()
        for task in self.tasks:
            task.cancel()
        self.persist(force=True)
        if self.rest:
            await self.rest.close()

    def info(self) -> dict:
        d = super().info()
        if self.ws:
            d["ws"] = {"connected": self.ws.connected, "messages": self.ws.messages,
                       "reconnects": self.ws.reconnects, "last_msg_ms": self.ws.last_msg_ms}
        if self.rest:
            d["rest"] = {"requests": self.rest.requests, "errors": self.rest.errors}
        return d


class SimRunner(BaseRunner):
    """Synthetic market at accelerated speed – shows the full pipeline and learning curve offline."""
    kind = "sim"

    def __init__(self, cfg: Config, speed: float = 120.0, seed: int | None = None, history_bars: int = 1500):
        super().__init__(cfg)
        self.speed = speed
        self.seed = seed if seed is not None else int(time.time()) % 100000
        self.history_bars = history_bars
        self.t0_real = time.time()
        self.t0_sim = now_ms()
        self.market: SyntheticMarket | None = None
        self.run_id = f"sim"

    def now(self) -> int:
        return int(self.t0_sim + (time.time() - self.t0_real) * 1000 * self.speed)

    async def setup(self) -> None:
        specs = offline_specs(self.cfg)
        for s in specs.values():
            s.is_equity = False  # synthetic markets trade around the clock
        self._init_state(specs)
        self.market = SyntheticMarket(list(specs), self.bar_ms, seed=self.seed)
        self.set_status("history", "Erzeuge synthetische Historie …")
        start = self.t0_sim - self.history_bars * self.bar_ms
        history = self.market.history(start, self.history_bars)
        self.calib = self.market.calibration()
        self._bootstrap(history)
        await asyncio.to_thread(self._pretrain, history)
        self.t0_real, self.t0_sim = time.time(), now_ms()
        self.market.sync_time(self.t0_sim)
        self._make_engine()
        self.set_status("sim", f"Simulation ×{self.speed:g} (synthetischer Markt, seed {self.seed})", 1.0)

    async def run(self) -> None:
        try:
            await self.setup()
        except Exception as e:
            self.set_status("error", f"Start fehlgeschlagen: {e}")
            log.exception("Setup fehlgeschlagen")
            return
        step_ms = 5_000
        while not self._stop.is_set():
            target = self.now()
            try:
                while self.market.t + step_ms <= target:
                    ev = self.market.step(step_ms)
                    for coin, e in ev.items():
                        self.feed_book(coin, e["book"], self.market.t)
                        if e["trades"]:
                            self.feed_trades(coin, e["trades"])
                        self.feed_ctx(coin, e["ctx"], self.market.t)
                    self.clock(self.market.t, grace_ms=0)
                self.persist()
            except Exception:  # noqa: BLE001
                log.exception("Fehler in der Simulation")
            await asyncio.sleep(0.2)
        self.persist(force=True)


def _jd(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (set, tuple)):
        return list(o)
    raise TypeError(type(o))


def new_run_id() -> str:
    return uuid.uuid4().hex[:8]
