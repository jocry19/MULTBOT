"""Simulated isolated-margin perp account (Hyperliquid mechanics).

* Initial margin  = notional / leverage (leverage = max leverage of the asset)
* Maintenance     = notional × 1 / (2 × max leverage)            (HL docs)
* Liquidation px  = (entry − side · margin / size) / (1 − side · mm_rate)
  (identical to HL's ``price − side · margin_available / size / (1 − l · side)``)
* Fees are paid from the free balance, funding is settled hourly against the isolated margin.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Position:
    coin: str
    side: int                  # +1 long, −1 short
    size: float                # base units
    entry_px: float
    leverage: int
    maint_rate: float
    margin: float              # isolated margin (changes with funding)
    init_margin: float
    opened_ms: int
    stop_px: float
    tp_px: float
    init_stop_px: float
    entry_fee: float
    atr: float
    funding: float = 0.0       # net funding paid (+ = paid, − = received)
    bars: int = 0
    mfe: float = 0.0           # best excursion (fraction of entry)
    mae: float = 0.0           # worst excursion (fraction of entry, ≤ 0)
    best_px: float = 0.0
    trail_active: bool = False
    regime: str = ""
    score: float = 0.0
    pwin: float | None = None
    entry_slip_bps: float = 0.0
    eq_entry: float = 0.0      # account equity when the trade was opened
    reasons: list = field(default_factory=list)
    meta_x: list | None = None
    decision: dict = field(default_factory=dict)

    @property
    def risk_per_unit(self) -> float:
        return abs(self.entry_px - self.init_stop_px)

    def notional(self, px: float) -> float:
        return self.size * px

    def upnl(self, px: float) -> float:
        return self.side * self.size * (px - self.entry_px)

    def equity(self, px: float) -> float:
        return self.margin + self.upnl(px)

    def maint_margin(self, px: float) -> float:
        return self.size * px * self.maint_rate

    def liq_price(self) -> float:
        if self.size <= 0:
            return 0.0
        p = (self.entry_px - self.side * self.margin / self.size) / (1 - self.side * self.maint_rate)
        return max(p, 0.0)

    def liq_distance(self, px: float) -> float:
        """Fractional distance from px to the liquidation price (positive = safe)."""
        lp = self.liq_price()
        return (px - lp) / px if self.side > 0 else (lp - px) / px

    def r_multiple(self, px: float) -> float:
        rpu = self.risk_per_unit
        return self.side * (px - self.entry_px) / rpu if rpu > 0 else 0.0

    def roe(self, px: float) -> float:
        return self.upnl(px) / self.init_margin if self.init_margin > 0 else 0.0

    def to_dict(self, px: float | None = None) -> dict:
        d = asdict(self)
        d.pop("meta_x", None)
        d["liq_px"] = self.liq_price()
        if px:
            d.update(mark=px, upnl=self.upnl(px), roe=self.roe(px), notional=self.notional(px),
                     liq_dist=self.liq_distance(px), r=self.r_multiple(px), equity=self.equity(px),
                     maint=self.maint_margin(px))
        return d


class Account:
    def __init__(self, starting_balance: float):
        self.start = float(starting_balance)
        self.balance = float(starting_balance)
        self.positions: dict[str, Position] = {}
        self.epoch = 1
        self.epoch_start_ms = 0
        self.epochs: list[dict] = []
        self.realized = 0.0
        self.fees = 0.0
        self.funding = 0.0
        self.liquidations = 0
        self.n_trades = 0
        self.wins = 0
        self.peak = float(starting_balance)
        self.max_dd = 0.0

    # ── valuation ─────────────────────────────────────────────────────────
    def equity(self, marks: dict[str, float]) -> float:
        return self.balance + sum(p.equity(marks.get(c, p.entry_px)) for c, p in self.positions.items())

    def upnl(self, marks: dict[str, float]) -> float:
        return sum(p.upnl(marks.get(c, p.entry_px)) for c, p in self.positions.items())

    def used_margin(self) -> float:
        return sum(p.margin for p in self.positions.values())

    def update_drawdown(self, equity: float) -> float:
        self.peak = max(self.peak, equity)
        dd = 1 - equity / self.peak if self.peak > 0 else 0.0
        self.max_dd = max(self.max_dd, dd)
        return dd

    # ── lifecycle ─────────────────────────────────────────────────────────
    def open(self, pos: Position) -> None:
        if pos.coin in self.positions:
            raise ValueError(f"Position {pos.coin} existiert bereits")
        cost = pos.margin + pos.entry_fee
        if cost > self.balance + 1e-9:
            raise ValueError(f"Zu wenig Guthaben: benötigt {cost:.2f}, frei {self.balance:.2f}")
        self.balance -= cost
        self.fees += pos.entry_fee
        self.positions[pos.coin] = pos

    def close(self, coin: str, exit_px: float, exit_fee: float, reason: str, ms: int,
              liquidation: bool = False, exit_slip_bps: float = 0.0) -> dict:
        p = self.positions.pop(coin)
        pnl = p.upnl(exit_px)
        returned = p.margin + pnl - exit_fee
        if liquidation:
            self.liquidations += 1
        returned = max(returned, 0.0)          # isolated: loss capped at the isolated margin
        self.balance += returned
        self.fees += exit_fee
        net = returned - p.init_margin - p.entry_fee   # includes funding (taken from margin) and both fees
        self.realized += net
        self.n_trades += 1
        self.wins += int(net > 0)
        return {
            "epoch": self.epoch, "coin": coin, "side": p.side, "size": p.size, "leverage": p.leverage,
            "entry_px": p.entry_px, "exit_px": exit_px, "entry_ms": p.opened_ms, "exit_ms": ms,
            "margin": p.init_margin, "pnl": pnl, "fees": p.entry_fee + exit_fee, "funding": p.funding,
            "net": net, "roe": net / p.init_margin if p.init_margin else 0.0,
            "r_multiple": (net / (p.risk_per_unit * p.size)) if p.risk_per_unit * p.size > 0 else 0.0,
            "reason": reason, "regime": p.regime, "score": p.score, "pwin": p.pwin, "mae": p.mae, "mfe": p.mfe,
            "bars": p.bars, "liquidation": liquidation, "eq_entry": p.eq_entry, "entry_slip_bps": p.entry_slip_bps,
            "exit_slip_bps": exit_slip_bps, "meta_x": p.meta_x,
            "detail": {"reasons": p.reasons, "init_stop": p.init_stop_px, "tp": p.tp_px, "atr": p.atr,
                       "decision": p.decision},
        }

    def apply_funding(self, coin: str, rate_h: float, oracle_px: float) -> float:
        """Hourly funding: longs pay shorts when the rate is positive. Returns amount paid (+) / received (−)."""
        p = self.positions.get(coin)
        if not p or oracle_px <= 0:
            return 0.0
        pay = p.side * p.size * oracle_px * rate_h
        p.margin -= pay
        p.funding += pay
        self.funding += pay
        return pay

    def new_epoch(self, ms: int, equity: float) -> None:
        self.epochs.append({"epoch": self.epoch, "start_ms": self.epoch_start_ms, "end_ms": ms,
                            "final_equity": equity, "trades": self.n_trades, "liquidations": self.liquidations})
        self.epoch += 1
        self.epoch_start_ms = ms
        self.balance = self.start
        self.positions.clear()
        self.peak = self.start

    def summary(self, marks: dict[str, float]) -> dict:
        eq = self.equity(marks)
        return {
            "equity": eq, "balance": self.balance, "upnl": self.upnl(marks), "used_margin": self.used_margin(),
            "start": self.start, "return": eq / self.start - 1, "epoch": self.epoch, "epochs": self.epochs[-20:],
            "realized": self.realized, "fees": self.fees, "funding": self.funding,
            "liquidations": self.liquidations, "trades": self.n_trades,
            "win_rate": self.wins / self.n_trades if self.n_trades else None,
            "peak": self.peak, "drawdown": 1 - eq / self.peak if self.peak > 0 else 0.0, "max_dd": self.max_dd,
            "exposure": sum(p.notional(marks.get(c, p.entry_px)) for c, p in self.positions.items()),
        }

    def to_dict(self) -> dict:
        return {"start": self.start, "balance": self.balance, "epoch": self.epoch,
                "epoch_start_ms": self.epoch_start_ms, "epochs": self.epochs, "realized": self.realized,
                "fees": self.fees, "funding": self.funding, "liquidations": self.liquidations,
                "n_trades": self.n_trades, "wins": self.wins, "peak": self.peak, "max_dd": self.max_dd,
                "positions": {c: asdict(p) for c, p in self.positions.items()}}

    def load(self, d: dict) -> None:
        for k in ("start", "balance", "epoch", "epoch_start_ms", "epochs", "realized", "fees", "funding",
                  "liquidations", "n_trades", "wins", "peak", "max_dd"):
            if k in d:
                setattr(self, k, d[k])
        self.positions = {c: Position(**p) for c, p in d.get("positions", {}).items()}
