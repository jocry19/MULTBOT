"""Runners: plumbing between a market data source and the engine.

* ``LiveRunner`` – Hyperliquid WebSocket + REST for hundreds of markets. Bars are built from the
  mark price (what HL uses for liquidations and stop triggers). History is loaded in the background
  by priority and every market is pre-trained individually. Order books are subscribed only for a
  dynamic focus set (positions, orders, strongest candidates, the market open in the dashboard).
* ``SimRunner``  – synthetic market with an accelerated virtual clock (offline demo / testing).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import numpy as np

from .. import __version__
from ..config import Config
from ..data.bars import Bar, BarSeries
from ..data.history import History, fetch_history
from ..data.store import Store
from ..exchange.hyperliquid import HLRest, HLWebSocket
from ..exchange.meta import MarketSpec, build_specs, offline_specs
from ..features.micro import MicroState
from ..features.pipeline import MICRO_KEYS, align_leader, compute_features, leader_of, row
from ..learning.brain import Brain
from ..research.backtest import prepare_features, run_backtest
from ..research.report import build_report
from ..util import HOUR_MS, INTERVAL_MS, now_ms
from .engine import Engine
from .sim import SyntheticMarket

log = logging.getLogger("multbot.runner")

FEATURE_WINDOW = 500
SERIES_LEN = 3000


class BaseRunner:
    kind = "base"

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.bar_ms = INTERVAL_MS[cfg.signal.interval]
        self.specs: dict[str, MarketSpec] = {}
        self.micro: dict[str, MicroState] = {}
        self.series: dict[str, BarSeries] = {}
        self.fund: dict[str, dict[int, tuple[float, float]]] = {}   # bar t → (funding/h, premium)
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
        self.watch: dict[str, float] = {}      # markets open in the dashboard → expiry (wall clock)
        self.fund_by_hour: dict[str, dict[int, float]] = {}

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
            self.series[c] = BarSeries(maxlen=SERIES_LEN)
            self.fund[c] = {}
            self.cur[c] = None
        self.store = Store(self.cfg.data_path(f"{self.run_id}.db"))
        self.brain = Brain(self.cfg, list(specs))
        self.brain.load_file(self.cfg.data_path(f"brain_{self.run_id}.json"))

    def _bootstrap_coin(self, coin: str, h: History) -> None:
        if not h.bars:
            return
        ts = np.array([b.t for b in h.bars], dtype=np.int64)
        if len(h.funding_t):
            fr, pr = h.funding_aligned(ts)
        else:  # no funding history fetched: current context is the best estimate
            m = self.micro[coin]
            fr, pr = np.full(len(ts), m.funding_h), np.full(len(ts), m.premium)
        fund = self.fund[coin]
        for t_, f_, p_ in zip(ts.tolist(), fr.tolist(), pr.tolist()):
            fund.setdefault(t_, (f_, p_))
        self.series[coin].merge(h.bars, prefer_existing=True)
        if not self.micro[coin].mark:
            self.micro[coin].mark = h.bars[-1].c

    def _bootstrap(self, history: dict[str, History]) -> None:
        for coin, h in history.items():
            self._bootstrap_coin(coin, h)

    def _pretrain(self, history: dict[str, History]) -> None:
        """Small universes (simulation): one walk-forward backtest over all markets → pretrain report."""
        if not self.cfg.learning.pretrain_on_history:
            return
        self.set_status("pretrain", "Vortraining auf Historie (Walk-Forward-Backtest) …", 0.0)

        def prog(x):
            self.status["progress"] = round(x, 3)

        prepared = prepare_features(history, self.specs, self.cfg.signal.interval, self.cfg.signal.use_lead_lag)
        res = run_backtest(self.cfg, self.specs, history, self.brain, self.calib, None, True, True, prog, prepared)
        rep = build_report(self.cfg, self.specs, history, res, self.brain, self.calib, label="pretrain")
        self.pretrain = rep
        try:
            self.cfg.data_path("research", f"pretrain_{self.run_id}.json").write_text(json.dumps(rep, default=_jd))
        except OSError as e:
            log.warning("Vortraining-Report nicht gespeichert: %s", e)
        self.brain.save(self.cfg.data_path(f"brain_{self.run_id}.json"))
        log.info("Vortraining fertig: %d Trades im Backtest, Brain n=%d", len(res.trades), self.brain.n_resolved)

    def _seed_returns(self, coin: str) -> None:
        if not self.engine:
            return
        a = self.series[coin].arrays(last=401)
        if len(a["c"]) < 3:
            return
        rets = np.diff(np.log(np.maximum(a["c"], 1e-300))).tolist()
        self.engine.seed_returns(coin, (a["t"][1:] + self.bar_ms).tolist(), rets)

    async def _pretrain_coin(self, coin: str) -> int:
        """Learn from one market's history inside the event loop (chunked, no threads, no trading)."""
        if not self.cfg.learning.pretrain_on_history or not self.engine:
            return 0
        a = self.series[coin].arrays()
        n = len(a["t"])
        if n <= self.cfg.signal.warmup_bars:
            return 0
        fr, pr = self._fund_arrays(coin, a["t"])
        f = compute_features(a, self.bar_ms, fr, pr, self._lead(coin, a["t"]))
        since = self.brain.trained_until.get(coin, 0)
        spread = self.engine.exec.spread_bps(coin, self.now())
        learned = 0
        for i in range(self.cfg.signal.warmup_bars, n):
            t_close = int(a["t"][i]) + self.bar_ms
            if t_close <= since:
                continue
            r = row(f, i)
            r["spread_bps"] = spread
            self.engine.learn_bar(coin, t_close, r)
            learned += 1
            if learned % 80 == 0:
                await asyncio.sleep(0)
        return learned

    def _make_engine(self) -> None:
        self.engine = Engine(self.cfg, self.specs, self.brain, self.store, run=self.run_id, mode=self.kind,
                             micro=self.micro, calib=self.calib)
        state = self.store.get_kv(f"engine:{self.run_id}")
        if state:
            self.engine.load_state(state)
            log.info("Konto wiederhergestellt: Epoche %d, Equity %.2f USD, %d offene Positionen",
                     self.engine.account.epoch, self.engine.equity(), len(self.engine.account.positions))
        else:
            levs = sorted({s.leverage for s in self.specs.values()})
            acc = self.cfg.account
            cap = (f"je Position {acc.position_margin_usd:.0f} USD Margin, Kapital unbegrenzt" if acc.fixed
                   else f"mit {acc.starting_balance:.2f} USD")
            self.engine.log_event(self.now(), "", "INFO",
                                  f"Neues Papierkonto {cap} – {len(self.specs)} Märkte, immer maximaler Hebel "
                                  f"({levs[0]}x–{levs[-1]}x)")
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
            if cur is not None:
                self._finalize(coin, cur, t)
                o = cur["c"]
            else:
                last = self.series[coin].last()
                o = last.c if last else px
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
                self.engine.on_trade(coin, float(tr["px"]), 1 if tr.get("side") == "B" else -1, int(tr["time"]),
                                     float(tr.get("sz", 0.0)))
        self.feed_stats["trades"] += len(trades)

    def feed_ctx(self, coin: str, ctx: dict, t: int) -> None:
        m = self.micro.get(coin)
        if not m:
            return
        m.update_ctx(ctx, t)
        self.feed_stats["ctx"] += 1
        fh = self.fund_by_hour.setdefault(coin, {})
        fh[t // HOUR_MS] = m.funding_h          # last predicted rate seen during each hour → paid at its end
        if len(fh) > 3:
            del fh[min(fh)]
        if m.mark > 0:
            self.feed_mark(coin, m.mark, t)

    def feed_book(self, coin: str, levels, t: int) -> None:
        m = self.micro.get(coin)
        if not m:
            return
        m.update_book(levels, t)
        self.feed_stats["book"] += 1
        if self.engine and coin in self.engine.awaiting_book:
            self.engine.retry_entry(coin, self.now())

    def is_ready(self, coin: str) -> bool:
        return bool(self.engine) and (self.engine.ready is None or coin in self.engine.ready)

    # ── bar closing / features ────────────────────────────────────────────
    def _finalize(self, coin: str, cur: dict, t: int, gap: bool = False) -> None:
        bar = Bar(cur["t"], cur["o"], cur["h"], cur["l"], cur["c"], cur["v"], cur["n"])
        m = self.micro[coin]
        self.series[coin].upsert(bar)
        fund = self.fund[coin]
        fund[bar.t] = (m.funding_h, m.premium)
        if len(fund) > SERIES_LEN + 200:
            first = self.series[coin].cols["t"][0]
            for k in [k for k in fund if k < first]:
                del fund[k]
        self.feed_stats["bars"] += 1
        if gap or not self.is_ready(coin):
            return
        frow = self.feature_row(coin, t)
        self.engine.on_bar_close(coin, cur["t"] + self.bar_ms, frow, len(self.series[coin]))

    def _fund_arrays(self, coin: str, ts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        fund = self.fund[coin]
        m = self.micro[coin]
        last = (m.funding_h, m.premium)
        first = next((fund[k] for k in ts.tolist() if k in fund), last)
        fr = np.empty(len(ts))
        pr = np.empty(len(ts))
        prev = first
        for i, k in enumerate(ts.tolist()):
            prev = fund.get(k, prev)
            fr[i], pr[i] = prev
        return fr, pr

    def _lead(self, coin: str, t: np.ndarray) -> np.ndarray | None:
        if not self.cfg.signal.use_lead_lag:
            return None
        lead_coin = leader_of(coin, self.specs[coin].asset_class, self.series)
        if not lead_coin or not len(self.series[lead_coin]):
            return None
        la = self.series[lead_coin].arrays(last=FEATURE_WINDOW + 50)
        return align_leader(t, la["t"], la["c"])

    def feature_row(self, coin: str, t: int) -> dict:
        a = self.series[coin].arrays(last=FEATURE_WINDOW)
        fr, pr = self._fund_arrays(coin, a["t"])
        f = compute_features(a, self.bar_ms, fr, pr, self._lead(coin, a["t"]))
        r = row(f)
        mf = self.micro[coin].features(t)
        for k in MICRO_KEYS:
            r[k] = mf.get(k, 0.0)
        if self.micro[coin].ctx_ms:
            r["premium_bps"] = mf["premium_bps"]
            r["funding_h"] = mf["funding_h"]
        return r

    async def clock(self, t: int, grace_ms: int = 1500) -> int:
        """Close due bars (also for silent markets), settle hourly funding. Yields to the event loop
        between markets so hundreds of bar closes never block WebSocket processing."""
        closed = 0
        for coin in list(self.cur):
            try:
                cur = self.cur[coin]
                if cur is None:
                    last = self.series[coin].last()
                    if last is None:
                        continue
                    cur = self.cur[coin] = {"t": last.t + self.bar_ms, "o": last.c, "h": last.c, "l": last.c,
                                            "c": last.c, "v": 0.0, "n": 0}
                n_here = 0
                while t >= cur["t"] + self.bar_ms + grace_ms:
                    # after a stall (sleep, blocked loop) only the first overdue bar is real; the rest are
                    # flat gap-fillers that must not trade, learn or age positions
                    self._finalize(coin, cur, t, gap=n_here > 0)
                    n_here += 1
                    closed += 1
                    px = cur["c"]
                    cur = self.cur[coin] = {"t": cur["t"] + self.bar_ms, "o": px, "h": px, "l": px, "c": px,
                                            "v": 0.0, "n": 0}
                    if closed % 12 == 0:
                        await asyncio.sleep(0)
                        if self.cur[coin] is not cur:   # a tick rolled the bar meanwhile: it is in charge now
                            break
            except Exception:  # noqa: BLE001 – one market must never stop the clock for all others
                log.exception("Bar-Abschluss %s fehlgeschlagen", coin)
        if self.engine and self.engine.entry_queue:
            self.engine.flush_entries(t - grace_ms)   # every market has closed these bars: rank and enter
        hour = t // HOUR_MS
        if self.engine and self.last_hour and hour > self.last_hour:
            for h in range(self.last_hour + 1, hour + 1):          # every missed hour is settled once
                for coin in list(self.engine.account.positions):
                    m = self.micro[coin]
                    rate = self.fund_by_hour.get(coin, {}).get(h - 1, m.funding_h)   # rate of the hour that ended
                    try:
                        self.engine.on_funding(coin, rate, m.oracle or m.mark, h * HOUR_MS)
                    except Exception:  # noqa: BLE001
                        log.exception("Funding %s fehlgeschlagen", coin)
        self.last_hour = hour
        if self.engine and t - self.last_equity_mark >= 10_000:
            self.last_equity_mark = t
            self.engine.mark_equity(t)
        return closed

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
    def watch_coin(self, coin: str) -> None:
        """The dashboard shows this market: keep its order book subscribed for a while."""
        if coin in self.specs:
            self.watch[coin] = time.time() + 120

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
        ready = len(self.specs) if not self.engine or self.engine.ready is None else len(self.engine.ready)
        return {"version": __version__, "kind": self.kind, "run": self.run_id, "status": self.status, "started": self.started_ms,
                "feed": self.feed_stats, "interval": self.cfg.signal.interval, "now": self.now(),
                "markets": len(self.specs), "ready": ready}


class LiveRunner(BaseRunner):
    kind = "live"

    def __init__(self, cfg: Config):
        super().__init__(cfg)
        self.rest: HLRest | None = None
        self.ws: HLWebSocket | None = None
        self.focus: dict[str, float] = {}      # coin → time it entered the focus set
        self.history_done = 0

    async def setup(self) -> None:
        self.set_status("meta", "Lade Hyperliquid-Meta (Hebel, Gebühren, Größen) …")
        self.rest = HLRest(self.cfg.api_url)
        metas, ctxs = {}, {}
        for dex in self.cfg.dexes:
            metas[dex], ctxs[dex] = await self.rest.meta_and_ctxs(dex)
        self._init_state(build_specs(self.cfg, metas, ctxs))
        self._apply_ctxs(metas, ctxs)
        self._make_engine()
        self.engine.ready = set()
        for v in self.engine.views.values():
            v.status = "LADE HISTORIE"
        self.set_status("warmup", f"Live – {len(self.specs)} Märkte, Historie wird im Hintergrund geladen", 0.0)

    def _apply_ctxs(self, metas: dict, ctxs: dict) -> None:
        t = self.now()
        for dex, meta in metas.items():
            for u, ctx in zip(meta["universe"], ctxs[dex]):
                if u["name"] in self.micro:
                    self.feed_ctx(u["name"], ctx, t)

    # ── subscriptions ─────────────────────────────────────────────────────
    def base_subscriptions(self) -> list[dict]:
        subs = []
        for c in self.specs:
            subs += [{"type": "activeAssetCtx", "coin": c}, {"type": "trades", "coin": c}]
        return subs

    def subscriptions(self) -> list[dict]:
        return self.base_subscriptions() + [{"type": "l2Book", "coin": c} for c in self.focus]

    def desired_focus(self) -> list[str]:
        e = self.engine
        # held / pending markets always keep their book; on top of that, room for the best new candidates
        # (WebSocket limit: 1000 subscriptions, two per market are already used for context and trades)
        held = len(e.account.positions) + len(e.pending_orders)
        limit = max(1, min(max(self.cfg.execution.book_focus, held + 20), 1000 - 2 * len(self.specs) - 10))
        now = time.time()
        self.watch = {c: exp for c, exp in self.watch.items() if exp > now}
        pri = list(e.account.positions) + list(e.pending_orders) + list(e.awaiting_book) + list(self.watch)
        pri += e.candidates(limit)
        # hysteresis: keep recent focus members for 10 minutes so books do not flap
        pri += [c for c, since in sorted(self.focus.items(), key=lambda kv: -kv[1]) if now - since < 600]
        out: list[str] = []
        for c in pri:
            if c in self.specs and c not in out:
                out.append(c)
            if len(out) >= limit:
                break
        return out

    async def update_focus(self) -> None:
        if not self.engine or not self.ws:
            return
        want = self.desired_focus()
        now = time.time()
        self.focus = {c: self.focus.get(c, now) for c in want}
        added, removed = await self.ws.update_subscriptions(self.subscriptions())
        if added or removed:
            log.debug("Orderbuch-Fokus: %d Märkte (+%d / −%d)", len(self.focus), added, removed)

    def watch_coin(self, coin: str) -> None:
        new = coin not in self.focus
        super().watch_coin(coin)
        if new and self.ws and self.engine:
            asyncio.get_running_loop().create_task(self.update_focus())

    async def on_ws(self, channel: str, data) -> None:
        t = self.now()
        if channel == "l2Book":
            self.feed_book(data["coin"], data.get("levels"), int(data.get("time", t)))
        elif channel == "trades":
            if data:
                self.feed_trades(data[0]["coin"], data)
        elif channel in ("activeAssetCtx", "activeSpotAssetCtx"):
            self.feed_ctx(data["coin"], data.get("ctx", {}), t)

    # ── background loops ──────────────────────────────────────────────────
    async def _history_loop(self) -> None:
        e = self.engine
        held = set(e.account.positions) | set(e.pending_orders)
        order = sorted(self.specs, key=lambda c: (c not in held, -self.specs[c].day_volume))
        with_funding = len(self.specs) <= 40
        queue: asyncio.Queue = asyncio.Queue()
        for c in order:
            queue.put_nowait(c)
        total = len(order)

        async def worker():
            while not self._stop.is_set():
                try:
                    coin = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    h = await fetch_history(self.cfg, self.rest, coin, self.cfg.signal.interval,
                                            self.cfg.learning.live_history_bars, with_funding=with_funding)
                    self._bootstrap_coin(coin, h)
                    self._seed_returns(coin)
                    learned = await self._pretrain_coin(coin)
                    log.debug("%s bereit: %d Bars, %d gelernt", coin, len(self.series[coin]), learned)
                except Exception as ex:  # noqa: BLE001 – a market without history still trades on live bars
                    log.warning("Historie %s fehlgeschlagen: %s", coin, ex)
                e.ready.add(coin)
                if e.views[coin].status == "LADE HISTORIE":
                    e.views[coin].status = "BEREIT – nächste Kerze"
                self.history_done += 1
                self.status["progress"] = round(self.history_done / total, 3)
                self.status["msg"] = (f"Live – Historie {self.history_done}/{total} Märkte geladen "
                                      f"(nach Volumen priorisiert)")

        await asyncio.gather(*(worker() for _ in range(4)))
        if not self._stop.is_set():
            if self.cfg.learning.clean_replay and self.brain.n_clean < 2000:
                try:
                    await self._clean_replay()
                except Exception:  # noqa: BLE001 – the warm-start brain keeps working
                    log.exception("Verschränktes Vortraining fehlgeschlagen – Warmstart-Lernstand bleibt aktiv")
            self.brain.save(self.cfg.data_path(f"brain_{self.run_id}.json"))
            self.set_status("live", f"Live – {total} Märkte, WebSocket-Daten, simulierte Ausführung", 1.0)

    def _history_snapshot(self) -> dict[str, History]:
        """Loaded + live bars of every market as History objects (funding per bar from the feed cache)."""
        out = {}
        for coin, s in self.series.items():
            if len(s) <= self.cfg.signal.warmup_bars:
                continue
            a = s.arrays()
            bars = [Bar(int(t), float(o), float(h), float(l), float(c), float(v), int(n))
                    for t, o, h, l, c, v, n in zip(a["t"], a["o"], a["h"], a["l"], a["c"], a["v"], a["n"])]
            fund = self.fund[coin]
            ft = np.array([t for t in a["t"].tolist() if t in fund], dtype=np.int64)
            out[coin] = History(coin=coin, interval=self.cfg.signal.interval, bars=bars, funding_t=ft,
                                funding_rate=np.array([fund[t][0] for t in ft.tolist()]),
                                premium=np.array([fund[t][1] for t in ft.tolist()]))
        return out

    async def _clean_replay(self) -> None:
        """Re-learn the loaded history of all markets *together, bar by bar* with a fresh brain – exactly like
        a backtest, so no market learns from another market's future – and swap it in. The market-by-market
        warm start keeps the bot working while this runs."""
        hist = self._history_snapshot()
        if len(hist) < 2:
            return
        specs = {c: self.specs[c] for c in hist}
        bars = sum(len(h.bars) for h in hist.values())
        self.set_status("pretrain", f"Lernstand: verschränktes Vortraining über {len(hist)} Märkte "
                                    f"({bars:,} Bars) – Live-Handel läuft weiter".replace(",", "."), 0.0)
        brain = Brain(self.cfg, list(self.specs))

        def prog(x):
            self.status["progress"] = round(x, 3)

        def job():
            prepared = prepare_features(hist, specs, self.cfg.signal.interval, self.cfg.signal.use_lead_lag)
            run_backtest(self.cfg, specs, hist, brain, self.calib or None, None, False, False, prog, prepared)

        t0 = time.time()
        await asyncio.to_thread(job)
        if self._stop.is_set():
            return
        for coin, h in hist.items():   # live keeps learning from the next bar on, nothing twice
            brain.trained_until[coin] = int(h.bars[-1].t) + self.bar_ms
        self.brain = brain
        self.engine.brain = brain
        log.info("Verschränktes Vortraining fertig in %.0fs: %d saubere Auswertungen, Bewegung Ø %.1f bps",
                 time.time() - t0, brain.n_clean, brain._pooled_move() * 1e4)
        self.engine.log_event(self.now(), "", "INFO",
                              f"Lernstand ersetzt: zeitlich verschränkt über {len(hist)} Märkte neu gelernt "
                              f"({brain.n_clean:,} saubere Auswertungen) – kein markt-übergreifender "
                              f"Zukunfts-Leak".replace(",", "."))

    async def _clock_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if await self.clock(self.now()):
                    await self.update_focus()
                self.persist()
            except Exception:  # noqa: BLE001
                log.exception("Fehler im Takt-Loop")
            await asyncio.sleep(1.0)

    async def _focus_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(10)
            try:
                await self.update_focus()
            except Exception:  # noqa: BLE001
                log.exception("Fehler beim Orderbuch-Fokus")

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
        self.focus = {c: time.time() for c in self.desired_focus()}
        self.ws = HLWebSocket(self.cfg.ws_url, self.subscriptions(), self.on_ws)
        self.tasks = [asyncio.create_task(self.ws.run()), asyncio.create_task(self._clock_loop()),
                      asyncio.create_task(self._ctx_loop()), asyncio.create_task(self._focus_loop()),
                      asyncio.create_task(self._history_loop())]
        await self._stop.wait()
        self.ws.stop()
        for task in self.tasks:
            task.cancel()
        self.persist(force=True)
        if self.rest:
            await self.rest.close()

    def info(self) -> dict:
        d = super().info()
        d["focus"] = list(self.focus)
        if self.ws:
            d["ws"] = {"connected": self.ws.connected, "messages": self.ws.messages,
                       "reconnects": self.ws.reconnects, "last_msg_ms": self.ws.last_msg_ms,
                       "subscriptions": len(self.ws.subscriptions)}
        if self.rest:
            d["rest"] = {"requests": self.rest.requests, "errors": self.rest.errors}
        return d


class SimRunner(BaseRunner):
    """Synthetic market at accelerated speed – shows the full pipeline and learning curve offline."""
    kind = "sim"

    def __init__(self, cfg: Config, speed: float = 120.0, seed: int | None = None, history_bars: int = 1500,
                 markets: int = 20):
        super().__init__(cfg)
        self.speed = speed
        self.seed = seed if seed is not None else int(time.time()) % 100000
        self.history_bars = history_bars
        self.markets = markets
        self.t0_real = time.time()
        self.t0_sim = now_ms()
        self.market: SyntheticMarket | None = None
        self.run_id = "sim"

    def now(self) -> int:
        return int(self.t0_sim + (time.time() - self.t0_real) * 1000 * self.speed)

    async def setup(self) -> None:
        specs = offline_specs(self.cfg, limit=self.markets)
        self._init_state(specs)
        self.market = SyntheticMarket(list(specs), self.bar_ms, seed=self.seed)
        self.set_status("history", f"Erzeuge synthetische Historie für {len(specs)} Märkte …")
        start = self.t0_sim - self.history_bars * self.bar_ms
        history = self.market.history(start, self.history_bars)
        self.calib = self.market.calibration()
        self._bootstrap(history)
        await asyncio.to_thread(self._pretrain, history)
        self.t0_real, self.t0_sim = time.time(), now_ms()
        self.market.sync_time(self.t0_sim)
        self._make_engine()
        for coin in self.specs:
            self._seed_returns(coin)
        self.set_status("sim", f"Simulation ×{self.speed:g} ({len(specs)} synthetische Märkte, seed {self.seed})", 1.0)

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
                    await self.clock(self.market.t, grace_ms=0)
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
