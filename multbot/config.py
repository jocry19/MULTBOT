"""Configuration: dataclass defaults overridden by config.yaml."""
from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass
class AssetCfg:
    coin: str
    leverage: Any = "max"  # int or "max"

    @property
    def dex(self) -> str:
        return self.coin.split(":", 1)[0] if ":" in self.coin else ""

    @property
    def symbol(self) -> str:
        return self.coin.split(":", 1)[1] if ":" in self.coin else self.coin


@dataclass
class AccountCfg:
    starting_balance: float = 100.0
    restart_on_ruin: bool = True
    ruin_threshold: float = 5.0


@dataclass
class RiskCfg:
    max_open_positions: int = 4
    base_margin_pct: float = 0.18
    min_margin_pct: float = 0.06
    max_margin_pct: float = 0.35
    max_total_margin_pct: float = 0.90
    min_notional: float = 10.0
    max_spread_bps: float = 80.0
    max_book_participation: float = 0.35
    stop_atr: float = 2.2
    tp_r: float = 2.2
    trail_after_r: float = 1.0
    trail_atr: float = 1.6
    max_hold_bars: int = 72
    stop_liq_frac: float = 0.60
    daily_loss_pause_pct: float = 0.45
    corr_limit: float = 0.85
    skip_stale_markets: bool = True
    funding_guard_bps: float = 6.0


@dataclass
class SignalCfg:
    interval: str = "5m"
    entry_threshold: float = 0.28
    exit_threshold: float = 0.22
    min_agreement: float = 0.55
    min_pwin: float = 0.53
    ml_blend: float = 0.30
    horizon: int = 3
    decay_horizons: list = field(default_factory=lambda: [1, 2, 3, 6, 12, 24, 48])
    warmup_bars: int = 150


@dataclass
class LearningCfg:
    hedge_eta: float = 0.06
    hedge_floor: float = 0.015
    hedge_decay: float = 0.999
    lr: float = 0.03
    l2: float = 0.0005
    meta_min_samples: int = 200
    pretrain_on_history: bool = True
    history_bars: int = 4000
    persist_every_s: int = 60


@dataclass
class FeesCfg:
    base_taker: float = 0.00045
    base_maker: float = 0.00015
    use_exchange_scaling: bool = True


@dataclass
class ExecutionCfg:
    book_levels: int = 20
    latency_ms: int = 300
    extra_slippage_bps: float = 1.0
    synthetic_spread_bps: float = 12.0
    entry_mode: str = "maker"        # "maker" = Limit am Best-Bid/-Ask, "taker" = sofort Market
    maker_timeout_bars: int = 2
    tp_maker: bool = True            # Take-Profit als ruhende Limit-Order (Maker-Gebühr, kein Spread)


@dataclass
class ResearchCfg:
    train_frac: float = 0.40
    mc_paths: int = 3000
    mc_trades: int = 200


@dataclass
class WebCfg:
    host: str = "127.0.0.1"
    port: int = 8050
    push_interval_s: float = 1.0


@dataclass
class Config:
    assets: list = field(default_factory=list)
    account: AccountCfg = field(default_factory=AccountCfg)
    risk: RiskCfg = field(default_factory=RiskCfg)
    signal: SignalCfg = field(default_factory=SignalCfg)
    learning: LearningCfg = field(default_factory=LearningCfg)
    fees: FeesCfg = field(default_factory=FeesCfg)
    execution: ExecutionCfg = field(default_factory=ExecutionCfg)
    research: ResearchCfg = field(default_factory=ResearchCfg)
    web: WebCfg = field(default_factory=WebCfg)
    data_dir: str = "data"
    api_url: str = "https://api.hyperliquid.xyz"
    ws_url: str = "wss://api.hyperliquid.xyz/ws"

    @property
    def coins(self) -> list[str]:
        return [a.coin for a in self.assets]

    @property
    def dexes(self) -> list[str]:
        return sorted({a.dex for a in self.assets})

    def data_path(self, *parts: str) -> Path:
        p = Path(self.data_dir).joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def to_dict(self) -> dict:
        return _asdict(self)


def _asdict(obj):
    if is_dataclass(obj):
        return {f.name: _asdict(getattr(obj, f.name)) for f in fields(obj)}
    if isinstance(obj, list):
        return [_asdict(x) for x in obj]
    return obj


def _merge(dc, values: dict):
    known = {f.name for f in fields(dc)}
    for key, val in (values or {}).items():
        if key not in known:
            raise ValueError(f"Unbekannter Konfigurationsschlüssel: {type(dc).__name__}.{key}")
        cur = getattr(dc, key)
        if is_dataclass(cur) and isinstance(val, dict):
            _merge(cur, val)
        else:
            setattr(dc, key, val)


DEFAULT_ASSETS = [
    ("xyz:GEV", 10), ("HMSTR", 3), ("xyz:EBAY", 10), ("xyz:SHEIN", 10), ("TNSR", 3),
    ("xyz:LYTE", 10), ("xyz:OURA", 5), ("xyz:XBI", 10), ("xyz:KSTR", 10), ("xyz:BIRD", 10),
]


def load_config(path: str | Path | None = "config.yaml", overrides: dict | None = None) -> Config:
    cfg = Config()
    raw: dict = {}
    if path and Path(path).exists():
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    raw = {**raw, **(overrides or {})}
    assets_raw = raw.pop("assets", None)
    _merge(cfg, raw)
    if assets_raw:
        cfg.assets = [AssetCfg(coin=str(a["coin"]), leverage=a.get("leverage", "max")) for a in assets_raw]
    else:
        cfg.assets = [AssetCfg(c, lev) for c, lev in DEFAULT_ASSETS]
    return cfg
