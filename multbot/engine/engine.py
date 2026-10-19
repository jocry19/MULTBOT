"""Decision engine shared by live trading, simulation and backtests."""
from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from ..config import Config
from ..data.store import Store
from ..exchange.meta import MarketSpec
from ..features.micro import MicroState
from ..features.regime import classify
from ..learning.brain import Brain
from ..strategies.library import BY_KEY, ML_KEY, evaluate_all
from ..util import HOUR_MS, fmt_ts
from .account import Account, Position
from .execution import ExecutionModel
from .risk import RiskManager

log = logging.getLogger("multbot.engine")

VIEW_FEATURES = ["rsi_14", "adx", "hurst", "er_20", "vol_pct", "atr_pct", "bb_z", "macd_hist_z", "kf_slope_z",
                 "funding_h", "funding_z", "premium_bps", "stale", "session", "spread_bps", "book_imb5", "flow_imb",
                 "oi_chg", "vwap_dev", "tsmom", "depth_usd", "trade_rate", "vol_z", "ret_12"]


@dataclass
class CoinView:
    coin: str
    px: float = 0.0
    t: int = 0
    bars: int = 0
    regime: dict = field(default_factory=dict)
    final: float = 0.0
    ens: float = 0.0
    p_up: float = 0.5
    pwin: float | None = None
    exp_roe: float | None = None     # expected net return on the margin (leverage × (move − costs))
    agreement: float = 0.0
    coverage: float = 0.0
    contrib: list = field(default_factory=list)
    signals: dict = field(default_factory=dict)
    features: dict = field(default_factory=dict)
    status: str = "WARMUP"
    history: deque = field(default_factory=lambda: deque(maxlen=288))


class Engine:
    def __init__(self, cfg: Config, specs: dict[str, MarketSpec], brain: Brain, store: Store | None = None,
                 run: str = "live", mode: str = "live", micro: dict[str, MicroState] | None = None,
                 calib: dict[str, dict] | None = None, journal_size: int = 1500):
        self.cfg = cfg
        self.specs = specs
        self.brain = brain
        self.store = store
        self.run = run
        self.mode = mode
        self.micro = micro or {}
        fixed = cfg.account.fixed
        self.account = Account(cfg.reference_capital if fixed else cfg.account.starting_balance, unlimited=fixed)
        self.risk = RiskManager(cfg)
        self.exec = ExecutionModel(cfg, specs, self.micro, calib)
        self.views = {c: CoinView(c) for c in specs}
        self.last_px: dict[str, float] = {}
        self.last_t = 0
        self.journal: deque = deque(maxlen=journal_size)
        self.trades: list[dict] = []
        self.equity_curve: deque = deque(maxlen=30000)
        self.hourly_eq: deque = deque(maxlen=48)
        self.returns: dict[str, deque] = {c: deque(maxlen=400) for c in specs}
        self.pending_orders: dict[str, dict] = {}
        self.paused_until = 0
        self.manual_pause = False
        self.counters = {"bars": 0, "signals": 0, "entries": 0, "rejected": 0, "exits": 0, "funding_events": 0,
                         "orders": 0, "maker_fills": 0, "cancels": 0}
        self.reject_reasons: dict[str, int] = {}
        self._last_equity_store = 0
        self.awaiting_book: dict[str, int] = {}
        self.last_analysis: dict[str, dict] = {}
        self._last_skip: dict[str, tuple] = {}
        self.ready: set[str] | None = None   # None = all markets ready (backtest/sim)
        self.entry_queue: dict[int, list[str]] = {}   # bar close time → candidates, ranked in flush_entries

    # ── helpers ───────────────────────────────────────────────────────────
    def marks(self) -> dict[str, float]:
        return dict(self.last_px)

    def equity(self) -> float:
        return self.account.equity(self.last_px)

    def log_event(self, t: int, coin: str, kind: str, text: str, detail: dict | None = None) -> None:
        entry = {"ts": t, "coin": coin, "kind": kind, "text": text, "detail": detail or {}}
        self.journal.append(entry)
        if self.store:
            self.store.add_journal(self.run, t, coin, kind, text, detail)
        if kind in ("ENTRY", "EXIT", "LIQ", "RUIN") and self.mode != "backtest":
            log.info("[%s] %s %s", kind, coin, text)

    # ── bar close: the main decision step ─────────────────────────────────
    def analyze(self, coin: str, t: int, frow: dict[str, float], learn: bool = True) -> dict:
        """Regime, strategy votes, ensemble decision and meta model for one closed bar."""
        cfg = self.cfg
        regime = classify(frow, 0.75 if cfg.risk.skip_stale_markets else 1.01, cfg.risk.max_oracle_age_min)
        sig = evaluate_all(frow)
        scores = {k: s for k, (s, _) in sig.items()}
        d = self.brain.decide(coin, regime.label, scores, frow)
        final = d["final"]
        cand = (1 if final > 0 else -1) if abs(final) >= 0.5 * cfg.signal.entry_threshold else 0
        cost = self.exec.round_trip_cost(coin, t)
        if cand:  # funding the position would pay while held (HIP-3 funding can be 0.5 %/8 h)
            cost += max(0.0, cand * frow.get("funding_h", 0.0)) * cfg.signal.funding_hold_hours
        meta_x = self.brain.meta_vector(d, frow, cand, regime.label) if cand else None
        pwin = self.brain.p_win(meta_x) if meta_x is not None else None
        exp_move = exp_roe = None
        if cand:
            em = self.brain.expected_move(coin, final, frow.get("vol", 0.0))
            if em is not None:
                exp_move = cand * em                                     # favourable move, fraction of price
                exp_roe = self.specs[coin].leverage * (exp_move - cost)  # net return on the 100 USD margin
        if learn:
            self.brain.observe(coin, t, frow["close"], frow.get("vol", 1e-4), regime.label, d, frow, meta_x, cand,
                               cost)
        return {"regime": regime, "sig": sig, "d": d, "final": final, "cand": cand, "meta_x": meta_x, "pwin": pwin,
                "exp_move": exp_move, "exp_roe": exp_roe, "cost": cost}

    def seed_returns(self, coin: str, closes_t: list[int], rets: list[float]) -> None:
        """History bar returns so correlation guards work from the first live minute."""
        have = {t for t, _ in self.returns[coin]}
        merged = sorted([(t, r) for t, r in zip(closes_t, rets) if t not in have] + list(self.returns[coin]))
        self.returns[coin].clear()
        self.returns[coin].extend(merged[-self.returns[coin].maxlen:])

    def learn_bar(self, coin: str, t: int, frow: dict[str, float]) -> None:
        """Learning only (history pre-training): no views, no positions, no orders."""
        self.brain.on_bar(coin, frow["close"], t)
        self.analyze(coin, t, frow, learn=True)

    def on_bar_close(self, coin: str, t: int, frow: dict[str, float], n_bars: int, trade: bool = True,
                     learn: bool = True) -> None:
        cfg = self.cfg
        spec = self.specs[coin]
        px = frow["close"]
        if coin not in self.last_px or self.mode == "backtest":
            self.last_px[coin] = px
        self.last_t = max(self.last_t, t)
        self.counters["bars"] += 1
        self.returns[coin].append((t, frow.get("ret_1", 0.0)))
        if learn:
            self.brain.on_bar(coin, px, t)
        v = self.views[coin]
        v.px, v.t, v.bars = self.last_px.get(coin, px), t, n_bars
        v.features = {k: frow.get(k, 0.0) for k in VIEW_FEATURES}
        if n_bars < cfg.signal.warmup_bars:
            v.status = f"WARMUP {n_bars}/{cfg.signal.warmup_bars}"
            return
        an = self.analyze(coin, t, frow, learn)
        regime, sig, d, final, pwin, meta_x = an["regime"], an["sig"], an["d"], an["final"], an["pwin"], an["meta_x"]
        th = cfg.signal.entry_threshold

        v.regime = regime.to_dict()
        v.final, v.ens, v.p_up, v.pwin, v.exp_roe = final, d["ens"], d["p_up"], pwin, an["exp_roe"]
        v.agreement, v.coverage = d["agreement"], d["coverage"]
        v.contrib = [[k, round(c, 4)] for k, c in d["contrib"]]
        v.signals = {k: [round(sc, 4), why] for k, (sc, why) in sig.items()}
        v.signals[ML_KEY] = [round(d["ml_score"], 4), f"P(↑) = {d['p_up']:.3f}" +
                             ("" if self.brain.ml_ready else " (lernt noch)")]
        v.history.append((t, round(final, 4)))

        po = self.pending_orders.get(coin)
        if po:
            po["bars"] += 1
            if po["side"] * final < 0.5 * th:
                self._cancel(coin, t, "Signal abgeschwächt")
            elif po["bars"] >= cfg.execution.maker_timeout_bars:
                self._cancel(coin, t, "Timeout – nicht gefüllt")
            else:
                v.status = f"ORDER {'BUY' if po['side'] > 0 else 'SELL'} @ {po['limit']:.6g}"
                return
        pos = self.account.positions.get(coin)
        if pos:
            pos.bars += 1
            if pos.side * final <= -cfg.signal.exit_threshold:
                self._close(coin, self.last_px.get(coin, px), "Signalumkehr", t)
            elif pos.bars >= cfg.risk.max_hold_bars:
                self._close(coin, self.last_px.get(coin, px), "Zeit-Stop", t)
        pos = self.account.positions.get(coin)
        if pos:
            v.status = f"{'LONG' if pos.side > 0 else 'SHORT'} {pos.leverage}x"
            return
        if not trade:
            v.status = "BEOBACHTEN"
            return
        if abs(final) < th:
            v.status = "NEUTRAL"
            self.awaiting_book.pop(coin, None)
            return
        self.counters["signals"] += 1
        self.last_analysis[coin] = {"t": t, "an": an, "frow": frow}
        if cfg.signal.rank_entries:
            self.entry_queue.setdefault(t, []).append(coin)   # entered best-first in flush_entries
            v.status = "KANDIDAT"
            return
        self._try_entry(coin, spec, an, frow, t)

    def _rank_key(self, coin: str) -> tuple:
        an = self.last_analysis[coin]["an"]
        er = an.get("exp_roe")
        if er is not None:
            return (1, er)
        return (0, abs(an["final"]) * self.specs[coin].leverage)   # before the move model has learned

    def flush_entries(self, upto: int | None = None) -> int:
        """Enter the queued candidates of each closed bar best-first: highest expected net return on the
        margin (expected move × leverage − costs × leverage) first, so concentration and correlation limits
        and ``max_new_per_bar`` always keep the better trades."""
        entered = 0
        for t in sorted(k for k in self.entry_queue if upto is None or k <= upto):
            coins = [c for c in self.entry_queue.pop(t) if self.last_analysis.get(c, {}).get("t") == t]
            ranked = sorted(coins, key=self._rank_key, reverse=True)
            cap = self.cfg.signal.max_new_per_bar
            new = 0
            for i, coin in enumerate(ranked):
                if coin in self.account.positions or coin in self.pending_orders:
                    continue
                la = self.last_analysis[coin]
                la["rank"] = (i + 1, len(ranked))
                if cap and new >= cap:
                    self._reject(coin, t, "Ranking", f"nicht unter den besten {cap} dieser Bar (Rang {i + 1}/"
                                 f"{len(ranked)})", la["an"])
                    continue
                if self._try_entry(coin, self.specs[coin], la["an"], la["frow"], t):
                    new += 1
                elif coin in self.awaiting_book:
                    new += 1   # keeps its rank while its order book loads
            entered += new
        return entered

    def _try_entry(self, coin: str, spec, an: dict, frow: dict, t: int) -> bool:
        final, d, pwin = an["final"], an["d"], an["pwin"]
        v = self.views[coin]
        ok, code, reason = self._entry_checks(coin, spec, final, d, pwin, an["regime"], frow, t, an.get("exp_roe"))
        if ok and self.mode == "live" and not self.exec.book_fresh(coin, t):
            # unfocused market: subscribe its order book first, enter as soon as it arrives (retry_entry)
            self.awaiting_book[coin] = t
            v.status = "WARTE AUF ORDERBUCH"
            return False
        if not ok:
            self._reject(coin, t, code, reason, an)
            return False
        self.awaiting_book.pop(coin, None)
        la = self.last_analysis.get(coin) or {}
        exp = {"exp_roe": an.get("exp_roe"), "exp_move": an.get("exp_move"), "rank": la.get("rank")}
        self._enter(coin, spec, 1 if final > 0 else -1, d, pwin, an["meta_x"], an["regime"].label, frow, t, exp)
        return True

    def _reject(self, coin: str, t: int, code: str, reason: str, an: dict) -> None:
        final = an["final"]
        self.views[coin].status = f"GESPERRT: {reason}"
        self.counters["rejected"] += 1
        self.reject_reasons[code] = self.reject_reasons.get(code, 0) + 1
        self._log_skip(t, coin, code, f"{'LONG' if final > 0 else 'SHORT'}-Signal {final:+.2f} verworfen: {reason}",
                       {"final": final, "pwin": an["pwin"], "exp_roe": an.get("exp_roe")})

    def retry_entry(self, coin: str, now: int) -> bool:
        """Called when the order book of a waiting candidate arrives (live)."""
        since = self.awaiting_book.get(coin)
        la = self.last_analysis.get(coin)
        if since is None or la is None or now - since > 150_000 or coin in self.account.positions \
                or coin in self.pending_orders:
            self.awaiting_book.pop(coin, None)
            return False
        return self._try_entry(coin, self.specs[coin], la["an"], la["frow"], now)

    def _log_skip(self, t: int, coin: str, code: str, text: str, detail: dict) -> None:
        """Rejections are counted always but only journaled when the reason changes or every 30 min."""
        if self.mode == "backtest":
            return
        last = self._last_skip.get(coin)
        if last and last[0] == code and t - last[1] < 30 * 60_000:
            return
        self._last_skip[coin] = (code, t)
        self.log_event(t, coin, "SKIP", text, detail)

    def _quality_gate(self, coin: str, regime_label: str) -> tuple[str, str] | None:
        """Learned filters: skip markets / regimes where the bot's own signal has shown no edge."""
        sc = self.cfg.signal
        b = self.brain
        if sc.market_gate_ic is not None:
            ic = b.ic_asset.get("final", {}).get(coin)
            if ic is not None and ic.n >= sc.gate_min_obs and ic.corr < sc.market_gate_ic:
                return "Markt ohne Kante (IC)", f"eigene Signale hier bisher ohne Kante (IC {ic.corr:+.3f}, n={ic.n})"
        if sc.regime_gate_ic is not None:
            ic = b.ic_regime.get("final", {}).get(regime_label)
            if ic is not None and ic.n >= sc.gate_min_obs and ic.corr < sc.regime_gate_ic:
                return "Regime ohne Kante (IC)", f"Regime {regime_label} bisher ohne Kante (IC {ic.corr:+.3f})"
        return None

    def candidates(self, limit: int = 40) -> list[str]:
        """Markets with the strongest current signals (for order-book focus)."""
        th = 0.5 * self.cfg.signal.entry_threshold
        rows = [((v.exp_roe is not None, v.exp_roe if v.exp_roe is not None else abs(v.final)), c)
                for c, v in self.views.items() if abs(v.final) >= th]
        return [c for _, c in sorted(rows, reverse=True)[:limit]]

    def _entry_checks(self, coin, spec, final, d, pwin, regime, frow, t, exp_roe=None) -> tuple[bool, str, str]:
        """Returns (ok, reason_code, human_text)."""
        cfg, r = self.cfg, self.cfg.risk
        side = 1 if final > 0 else -1
        if self.manual_pause:
            return False, "Pause (manuell)", "manuell pausiert"
        if t < self.paused_until:
            return False, "Tagesverlust-Pause", f"Tagesverlust-Pause bis {fmt_ts(self.paused_until)}"
        if d["agreement"] < cfg.signal.min_agreement:
            return False, "Strategien uneinig", f"Strategien uneinig ({d['agreement']:.0%} < {cfg.signal.min_agreement:.0%})"
        if r.skip_stale_markets and not regime.tradable:
            return False, regime.why, regime.why
        gate = self._quality_gate(coin, regime.label)
        if gate:
            return False, gate[0], gate[1]
        if pwin is not None and pwin < cfg.signal.min_pwin:
            return False, "Meta-Modell: Kante zu klein", f"Meta-Modell P(Gewinn) {pwin:.1%} < {cfg.signal.min_pwin:.0%}"
        if exp_roe is not None and cfg.signal.min_exp_roe is not None and exp_roe < cfg.signal.min_exp_roe:
            return False, "Erwartung zu klein", (f"erwartete Rendite {exp_roe:+.1%} auf die Margin nach Kosten "
                                                 f"< {cfg.signal.min_exp_roe:+.1%}")
        if r.max_open_positions and len(self.account.positions) + len(self.pending_orders) >= r.max_open_positions:
            return False, "max. Positionen", f"max. {r.max_open_positions} Positionen offen"
        spread = self.exec.spread_bps(coin, t)
        if spread > r.max_spread_bps:
            return False, "Spread zu breit", f"Spread zu breit ({spread:.0f} bps)"
        eq = self.equity()
        if not cfg.account.fixed and eq <= 0:
            return False, "kein Equity", "kein Equity"
        if not cfg.account.fixed and self.reserved_margin() / eq > r.max_total_margin_pct:
            return False, "Margin-Auslastung", "Margin-Auslastung zu hoch"
        to_funding_min = (HOUR_MS - t % HOUR_MS) / 60_000
        fund_bps = side * frow.get("funding_h", 0.0) * 1e4
        if to_funding_min < 10 and fund_bps > r.funding_guard_bps:
            return False, "Funding-Wächter", f"Funding {fund_bps:.1f} bps gegen uns in {to_funding_min:.0f} min"
        same = [o for o, p in self.account.positions.items() if p.side == side]
        same += [o for o, po in self.pending_orders.items() if po["side"] == side]
        same += [o for o in self.awaiting_book if o != coin and o in self.last_analysis    # better-ranked, book loading
                 and (self.last_analysis[o]["an"]["final"] > 0) == (side > 0)]
        cls = spec.asset_class
        n_cls = sum(1 for o in same if self.specs[o].asset_class == cls)
        if r.max_same_class_side and n_cls >= r.max_same_class_side:
            return False, "Klumpenrisiko", (f"schon {n_cls} {cls}-Positionen {'long' if side > 0 else 'short'} "
                                            f"(max. {r.max_same_class_side})")
        for other in same:
            c = self.correlation(coin, other)
            if c > r.corr_limit:
                return False, "Korrelation", f"korreliert mit {other} ({c:.2f})"
        return True, "", ""

    def reserved_margin(self) -> float:
        return self.account.used_margin() + sum(p["margin"] for p in self.pending_orders.values())

    def _enter(self, coin, spec, side, d, pwin, meta_x, regime_label, frow, t, exp: dict | None = None) -> None:
        ref = self.last_px.get(coin, frow["close"])
        maker = self.cfg.execution.entry_mode == "maker"
        px = self.exec.maker_price(coin, side, ref, t) if maker else ref
        eq = self.equity()
        free = self.account.balance - sum(p["margin"] for p in self.pending_orders.values())
        order, why = self.risk.size(spec, side, px, frow.get("atr", ref * 0.01), eq, free,
                                    d["final"], pwin, self.exec.spread_bps(coin, t),
                                    self.exec.depth_usd(coin, side, t), vol=frow.get("vol", 0.0))
        if order is None:
            self.views[coin].status = f"GESPERRT: {why}"
            self.counters["rejected"] += 1
            code = "Sizing: " + why.split(" (")[0]
            self.reject_reasons[code] = self.reject_reasons.get(code, 0) + 1
            self._log_skip(t, coin, code, f"Sizing verworfen: {why}", {})
            return
        ctx = {"coin": coin, "side": side, "size": order.size, "leverage": order.leverage,
               "stop_dist": order.stop_dist, "margin": order.margin, "d": d, "pwin": pwin, "meta_x": meta_x,
               "regime": regime_label, "atr": frow.get("atr", 0.0), "notes": order.notes,
               "margin_pct": order.margin_pct, "created": t, "bars": 0, "limit": px, "exp": exp or {}}
        if maker:
            self.pending_orders[coin] = ctx
            self.counters["orders"] += 1
            self.views[coin].status = f"ORDER {'BUY' if side > 0 else 'SELL'} @ {px:.6g}"
            if self.mode != "backtest":
                self.log_event(t, coin, "ORDER",
                               f"Limit-{'Kauf' if side > 0 else 'Verkauf'} {order.size:g} @ {px:.6g} "
                               f"({order.leverage}x, Margin {order.margin:.2f} USD) | Score {d['final']:+.2f} | "
                               f"gültig {self.cfg.execution.maker_timeout_bars} Bars",
                               {"limit": px, "size": order.size})
            return
        fill = self.exec.market(coin, side, order.size, ref, t)
        self._open_position(ctx, fill, t)

    def _cancel(self, coin: str, t: int, why: str) -> None:
        po = self.pending_orders.pop(coin, None)
        if not po:
            return
        self.counters["cancels"] += 1
        self.views[coin].status = "FLAT"
        if self.mode != "backtest":
            self.log_event(t, coin, "CANCEL", f"Limit-Order @ {po['limit']:.6g} storniert: {why}")

    def _try_fill_pending(self, coin: str, t: int, lo: float, hi: float, tick_mode: bool) -> bool:
        po = self.pending_orders.get(coin)
        if not po:
            return False
        lim, side = po["limit"], po["side"]
        hit = (lo < lim) if side > 0 else (hi > lim)
        if not hit:
            return False
        self.pending_orders.pop(coin)
        m = self.micro.get(coin)
        fill = self.exec.maker_fill(coin, side, po["size"], lim, m.mid if m and m.bids else None)
        self.counters["maker_fills"] += 1
        self._open_position(po, fill, t)
        return coin in self.account.positions

    def on_trade(self, coin: str, px: float, aggressor: int, t: int) -> None:
        """Live trade print: a sell aggressor at/below our bid (or buy at/above our ask) fills the limit."""
        po = self.pending_orders.get(coin)
        if po and aggressor == -po["side"] and po["side"] * (po["limit"] - px) >= 0:
            self._try_fill_pending(coin, t, px - 1e-12 if po["side"] > 0 else px,
                                   px + 1e-12 if po["side"] < 0 else px, True)

    def _open_position(self, ctx: dict, fill, t: int) -> None:
        coin, side, d, pwin = ctx["coin"], ctx["side"], ctx["d"], ctx["pwin"]
        spec = self.specs[coin]
        meta_x = ctx["meta_x"]
        eq = self.equity()
        notional = fill.px * ctx["size"]
        margin = notional / ctx["leverage"]
        if not self.account.unlimited and margin + fill.fee > self.account.balance:
            margin = (self.account.balance - fill.fee) * 0.999
            if margin * ctx["leverage"] < self.cfg.risk.min_notional:
                self.log_event(t, coin, "SKIP", "Eröffnung abgebrochen: Guthaben reicht nicht mehr")
                return
        stop_px = fill.px - side * ctx["stop_dist"]
        tp_px = fill.px + side * self.cfg.risk.tp_r * ctx["stop_dist"]
        reasons = [f"{BY_KEY[k].name if k in BY_KEY else 'ML'} {c:+.3f}" for k, c in d["contrib"][:5]]
        pos = Position(
            coin=coin, side=side, size=ctx["size"], entry_px=fill.px, leverage=ctx["leverage"],
            maint_rate=spec.maint_rate, margin=margin, init_margin=margin, opened_ms=t, stop_px=stop_px,
            tp_px=tp_px, init_stop_px=stop_px, entry_fee=fill.fee, atr=ctx["atr"], best_px=fill.px,
            regime=ctx["regime"], score=d["final"], pwin=pwin, entry_slip_bps=fill.slippage_bps, eq_entry=eq,
            reasons=reasons,
            meta_x=meta_x.tolist() if meta_x is not None else None,
            decision={"ens": round(d["ens"], 4), "p_up": round(d["p_up"], 4), "agreement": round(d["agreement"], 3),
                      "coverage": round(d["coverage"], 3), "contrib": [[k, round(c, 4)] for k, c in d["contrib"]],
                      "notes": ctx["notes"], "margin_pct": round(ctx["margin_pct"], 4), "fill": fill.source,
                      **{k: v for k, v in ctx.get("exp", {}).items() if v is not None}},
        )
        try:
            self.account.open(pos)
        except ValueError as e:
            self.log_event(t, coin, "SKIP", f"Eröffnung fehlgeschlagen: {e}")
            return
        self.counters["entries"] += 1
        lp = pos.liq_price()
        self.views[coin].status = f"{'LONG' if side > 0 else 'SHORT'} {ctx['leverage']}x"
        pw = f"{pwin:.0%}" if pwin is not None else "n/a"
        exp = ctx.get("exp") or {}
        er = f"E[ROE] {exp['exp_roe']:+.1%}" if exp.get("exp_roe") is not None else "E[ROE] lernt noch"
        rk = f" · Rang {exp['rank'][0]}/{exp['rank'][1]}" if exp.get("rank") else ""
        self.log_event(
            t, coin, "ENTRY",
            f"{'LONG' if side > 0 else 'SHORT'} {ctx['leverage']}x @ {fill.px:.6g} ({fill.source}) | Score "
            f"{d['final']:+.2f} (Einigkeit {d['agreement']:.0%}, P(Gewinn) {pw}) | {er}{rk} | Margin {margin:.2f} USD → "
            f"Notional {notional:.2f} USD | Stop {stop_px:.6g} · TP {tp_px:.6g} · Liq {lp:.6g} | Slippage "
            f"{fill.slippage_bps:+.1f} bps, Gebühr {fill.fee:.4f} | {ctx['regime']} | " + ", ".join(reasons),
            {"side": side, "px": fill.px, "size": ctx["size"], "margin": margin, "stop": stop_px, "tp": tp_px,
             "liq": lp, "fill_source": fill.source, "notes": ctx["notes"]},
        )

    # ── price updates: stops, take profits, liquidations, trailing ────────
    def on_price(self, coin: str, px: float, t: int, hi: float | None = None, lo: float | None = None,
                 open_px: float | None = None) -> None:
        if px <= 0:
            return
        self.last_px[coin] = px
        self.last_t = max(self.last_t, t)
        hi = px if hi is None else hi
        lo = px if lo is None else lo
        just_filled = coin in self.pending_orders and self._try_fill_pending(coin, t, lo, hi, hi == lo)
        pos = self.account.positions.get(coin)
        if not pos:
            return
        s = pos.side
        liq = pos.liq_price()
        if open_px is not None and not just_filled:
            if (s > 0 and open_px <= liq) or (s < 0 and open_px >= liq):
                self._close(coin, open_px, "LIQUIDATION (Gap)", t, liquidation=True)
                return
            if (s > 0 and open_px <= pos.stop_px) or (s < 0 and open_px >= pos.stop_px):
                self._close(coin, open_px, "Stop (Gap)", t)
                return
        adverse = lo if s > 0 else hi
        favorable = hi if s > 0 else lo
        tick_mode = hi == lo
        crossed_liq = (s > 0 and adverse <= liq) or (s < 0 and adverse >= liq)
        liq_before_stop = s * (liq - pos.stop_px) > 0   # e.g. funding ate the margin
        if crossed_liq and (tick_mode or liq_before_stop):
            self._close(coin, liq, "LIQUIDATION", t, liquidation=True)
            return
        if (s > 0 and adverse <= pos.stop_px) or (s < 0 and adverse >= pos.stop_px):
            reason = "Trailing-Stop" if pos.trail_active else "Stop-Loss"
            self._close(coin, adverse if tick_mode else pos.stop_px, reason, t)
            return
        if just_filled and not tick_mode:
            return  # intrabar order unknown after a limit fill: no take-profit / trailing in the fill bar
        if (s > 0 and favorable >= pos.tp_px) or (s < 0 and favorable <= pos.tp_px):
            if self.cfg.execution.tp_maker:
                self._close(coin, pos.tp_px, "Take-Profit", t, maker=True)
            else:
                self._close(coin, favorable if tick_mode else pos.tp_px, "Take-Profit", t)
            return
        exc_f = s * (favorable - pos.entry_px) / pos.entry_px
        exc_a = s * (adverse - pos.entry_px) / pos.entry_px
        pos.mfe = max(pos.mfe, exc_f)
        pos.mae = min(pos.mae, exc_a)
        if (s > 0 and favorable > pos.best_px) or (s < 0 and favorable < pos.best_px):
            pos.best_px = favorable
        if pos.r_multiple(pos.best_px) >= self.cfg.risk.trail_after_r:
            new_stop = pos.best_px - s * self.cfg.risk.trail_atr * pos.atr
            if not pos.trail_active:
                new_stop = s * max(s * new_stop, s * (pos.entry_px + s * pos.entry_px * 0.0005))  # ≥ break-even
            if s * new_stop > s * pos.stop_px:
                pos.stop_px = new_stop
                pos.trail_active = True
        self._check_ruin(t)

    def on_funding(self, coin: str, rate_h: float, oracle_px: float, t: int) -> None:
        pos = self.account.positions.get(coin)
        if not pos:
            return
        paid = self.account.apply_funding(coin, rate_h, oracle_px or self.last_px.get(coin, pos.entry_px))
        self.counters["funding_events"] += 1
        if self.mode != "backtest":
            self.log_event(t, coin, "FUND", f"Funding {rate_h * 100:+.4f}%/h → {'bezahlt' if paid > 0 else 'erhalten'} "
                           f"{abs(paid):.4f} USD", {"rate": rate_h, "paid": paid})

    # ── closing / ruin ────────────────────────────────────────────────────
    def _close(self, coin: str, ref_px: float, reason: str, t: int, liquidation: bool = False,
               maker: bool = False) -> dict | None:
        pos = self.account.positions.get(coin)
        if not pos:
            return None
        if maker:
            fill = self.exec.maker_fill(coin, -pos.side, pos.size, ref_px)
        else:
            fill = self.exec.market(coin, -pos.side, pos.size, ref_px, t)
        exit_px = fill.px
        trade = self.account.close(coin, exit_px, fill.fee, reason, t, liquidation, fill.slippage_bps)
        self.brain.learn_trade(trade.pop("meta_x"), trade["net"] > 0)
        self.trades.append(trade)
        if len(self.trades) > 5000:
            self.trades = self.trades[-4000:]
        self.counters["exits"] += 1
        if self.store:
            self.store.add_trade(self.run, trade)
        kind = "LIQ" if liquidation else "EXIT"
        self.log_event(
            t, coin, kind,
            f"{reason}: {'LONG' if pos.side > 0 else 'SHORT'} {pos.entry_px:.6g} → {exit_px:.6g} | "
            f"Netto {trade['net']:+.2f} USD ({trade['roe']:+.1%} ROE, {trade['r_multiple']:+.2f}R) | "
            f"Gebühren {trade['fees']:.4f}, Funding {trade['funding']:+.4f} | {pos.bars} Bars",
            {"net": trade["net"], "roe": trade["roe"], "reason": reason},
        )
        self.views[coin].status = "FLAT"
        self._check_ruin(t)
        return trade

    def close_all(self, t: int, reason: str = "Manuell geschlossen") -> None:
        for coin in list(self.pending_orders):
            self._cancel(coin, t, reason)
        for coin in list(self.account.positions):
            self._close(coin, self.last_px.get(coin, self.account.positions[coin].entry_px), reason, t)

    def _check_ruin(self, t: int) -> None:
        if self.account.unlimited:
            return  # fixed mode: capital is unlimited, there is no ruin – only PnL
        eq = self.equity()
        if eq >= self.cfg.account.ruin_threshold:
            return
        for coin in list(self.account.positions):
            p = self.account.positions[coin]
            fill = self.exec.market(coin, -p.side, p.size, self.last_px.get(coin, p.entry_px), t)
            tr = self.account.close(coin, fill.px, fill.fee, "Ruin – Zwangsschließung", t, False, fill.slippage_bps)
            tr.pop("meta_x", None)
            self.trades.append(tr)
            if self.store:
                self.store.add_trade(self.run, tr)
        eq = self.equity()
        self.log_event(t, "", "RUIN", f"Konto ruiniert in Epoche {self.account.epoch}: Equity {eq:.2f} USD"
                       + (" → neue Epoche mit Startkapital" if self.cfg.account.restart_on_ruin else " → Handel gestoppt"))
        if self.cfg.account.restart_on_ruin:
            self.account.new_epoch(t, eq)
        else:
            self.manual_pause = True

    # ── equity bookkeeping ────────────────────────────────────────────────
    def mark_equity(self, t: int) -> None:
        eq = self.equity()
        self.account.update_drawdown(eq)
        self.equity_curve.append((t, round(eq, 6), self.account.epoch))
        if not self.hourly_eq or t - self.hourly_eq[-1][0] >= HOUR_MS:
            self.hourly_eq.append((t, eq))
        recent = [e for ts, e in self.hourly_eq if t - ts <= 24 * HOUR_MS]
        pct = self.cfg.risk.daily_loss_pause_pct
        if 0 < pct < 1 and recent and eq < (1 - pct) * max(recent) and t >= self.paused_until:
            self.paused_until = t + 6 * HOUR_MS
            self.log_event(t, "", "INFO", f"Tagesverlust-Bremse: Equity {eq:.2f} < "
                           f"{1 - self.cfg.risk.daily_loss_pause_pct:.0%} des 24h-Hochs – 6 h keine neuen Trades")
        if self.store and t - self._last_equity_store >= 60_000:
            self._last_equity_store = t
            self.store.add_equity(self.run, t, self.account.epoch, eq, self.account.balance,
                                  self.account.upnl(self.last_px), self.account.used_margin())

    # ── analytics ─────────────────────────────────────────────────────────
    def correlation(self, a: str, b: str, n: int = 300) -> float:
        ra = dict(self.returns.get(a, ()))
        rb = dict(self.returns.get(b, ()))
        common = sorted(set(ra) & set(rb))[-n:]
        if len(common) < 30:
            return 0.0
        x = np.array([ra[k] for k in common])
        y = np.array([rb[k] for k in common])
        if x.std() <= 0 or y.std() <= 0:
            return 0.0
        return float(np.corrcoef(x, y)[0, 1])

    def corr_matrix(self, limit: int = 20) -> dict:
        held = list(self.account.positions)
        rest = sorted((c for c in self.specs if c not in held), key=lambda c: -self.specs[c].day_volume)
        coins = (held + rest)[:limit]
        return {"coins": coins, "m": [[1.0 if a == b else round(self.correlation(a, b), 3) for b in coins]
                                      for a in coins]}

    def positions_view(self) -> list[dict]:
        out = []
        for c, p in self.account.positions.items():
            px = self.last_px.get(c, p.entry_px)
            d = p.to_dict(px)
            d["age_min"] = (self.last_t - p.opened_ms) / 60_000 if self.last_t else 0
            out.append(d)
        return out

    def snapshot(self) -> dict:
        acc = self.account.summary(self.last_px)
        eq = list(self.equity_curve)
        step = max(1, len(eq) // 1500)
        return {
            "run": self.run, "mode": self.mode, "t": self.last_t, "paused": self.manual_pause,
            "paused_until": self.paused_until, "account": acc, "positions": self.positions_view(),
            "orders": [{k: v for k, v in po.items() if k not in ("d", "meta_x")} for po in self.pending_orders.values()],
            "assets": [self.asset_row(c) for c in self.specs],
            "journal": list(self.journal)[-150:],
            "trades": [{k: v for k, v in t.items() if k != "detail"} for t in self.trades[-150:]],
            "equity": eq[::step] + ([eq[-1]] if eq and (len(eq) - 1) % step else []),
            "counters": self.counters, "rejects": dict(sorted(self.reject_reasons.items(), key=lambda kv: -kv[1])[:12]),
            "brain": self.brain.snapshot(light=True),
        }

    def asset_row(self, coin: str) -> dict:
        """Compact per-market row for the 1-second dashboard push (hundreds of markets)."""
        v = self.views[coin]
        s = self.specs[coin]
        m = self.micro.get(coin)
        r = v.regime or {}
        fe = v.features
        px = self.last_px.get(coin, v.px)
        row = {"coin": coin, "symbol": s.symbol, "dex": s.dex or "main", "cls": s.asset_class, "lev": s.leverage,
               "px": px, "final": round(v.final, 4), "p_up": round(v.p_up, 4),
               "pwin": None if v.pwin is None else round(v.pwin, 4), "status": v.status,
               "eroe": None if v.exp_roe is None else round(v.exp_roe, 4),
               "regime": r.get("label", ""), "tradable": r.get("tradable", True),
               "spread": round(fe.get("spread_bps", 0.0), 2), "ready": self.ready is None or coin in self.ready}
        if m and m.ctx_ms:
            row.update(chg=(m.mark / m.prev_day_px - 1) if m.prev_day_px else None, fund=m.funding_h,
                       vol=m.day_volume, oi=m.open_interest * m.mark,
                       oracle_age=round((self.last_t - m.oracle_change_ms) / 60_000, 1) if m.oracle_change_ms else None)
        return row

    def signals_matrix(self, limit: int = 60, coins: list[str] | None = None, reasons: bool = True) -> dict:
        """Strategy × market score matrix, strongest signals first."""
        pool = coins or sorted(self.specs, key=lambda c: -abs(self.views[c].final))
        pool = [c for c in pool if self.views[c].signals][:limit]
        keys = list(self.views[pool[0]].signals) if pool else []
        rows = []
        for c in pool:
            v = self.views[c]
            rows.append({"coin": c, "symbol": self.specs[c].symbol, "final": v.final, "agreement": v.agreement,
                         "coverage": v.coverage, "p_up": v.p_up, "pwin": v.pwin, "status": v.status,
                         "contrib": v.contrib[:5],
                         "s": [v.signals.get(k, [0.0, ""])[0] for k in keys],
                         "why": [v.signals.get(k, [0.0, ""])[1] for k in keys] if reasons else None})
        return {"keys": keys, "rows": rows, "total": sum(1 for c in self.specs if self.views[c].signals)}

    def view_dict(self, coin: str) -> dict:
        v = self.views[coin]
        s = self.specs[coin]
        m = self.micro.get(coin)
        return {
            "coin": coin, "symbol": s.symbol, "dex": s.dex or "main", "leverage": s.leverage,
            "max_leverage": s.exchange_max_leverage, "taker_fee": s.taker_fee, "asset_class": s.asset_class,
            "ready": self.ready is None or coin in self.ready,
            "px": self.last_px.get(coin, v.px), "t": v.t, "bars": v.bars, "regime": v.regime, "final": v.final,
            "ens": v.ens, "p_up": v.p_up, "pwin": v.pwin, "agreement": v.agreement, "coverage": v.coverage,
            "contrib": v.contrib, "signals": v.signals, "features": v.features, "status": v.status,
            "history": list(v.history)[-120:], "ctx": m.ctx_snapshot() if m else {},
        }

    # ── persistence ───────────────────────────────────────────────────────
    def state_dict(self) -> dict:
        return {"account": self.account.to_dict(), "counters": self.counters, "paused_until": self.paused_until,
                "manual_pause": self.manual_pause, "equity_tail": list(self.equity_curve)[-5000:],
                "trades_tail": self.trades[-500:], "journal_tail": list(self.journal)[-500:]}

    def load_state(self, d: dict) -> None:
        if not d:
            return
        self.account.load(d.get("account", {}))
        for c in [c for c in self.account.positions if c not in self.specs]:
            p = self.account.positions.pop(c)
            self.account.balance += p.margin   # market removed from config: release margin at entry
            log.warning("Position %s gehört zu keinem konfigurierten Markt mehr – Margin freigegeben", c)
        self.counters.update(d.get("counters", {}))
        self.paused_until = int(d.get("paused_until", 0))
        self.manual_pause = bool(d.get("manual_pause", False))
        self.equity_curve.extend(tuple(x) for x in d.get("equity_tail", []))
        self.trades = list(d.get("trades_tail", []))
        self.journal.extend(d.get("journal_tail", []))
        for c, p in self.account.positions.items():
            self.last_px.setdefault(c, p.entry_px)
            if c in self.views:
                self.views[c].status = f"{'LONG' if p.side > 0 else 'SHORT'} {p.leverage}x"
