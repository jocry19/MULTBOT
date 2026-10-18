"""Market specifications: leverage, size decimals, fee model per asset."""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass

from ..config import Config
from ..util import finite

log = logging.getLogger("multbot.meta")


@dataclass
class MarketSpec:
    coin: str
    dex: str
    symbol: str
    exchange_max_leverage: int
    leverage: int                 # leverage used for every trade (= max by default)
    sz_decimals: int
    only_isolated: bool
    growth_mode: bool
    deployer_fee_scale: float
    taker_fee: float
    maker_fee: float
    is_equity: bool               # equity/ETF perp (oracle follows US session)
    note: str = ""

    @property
    def maint_rate(self) -> float:
        """Maintenance margin rate = half the initial margin at max leverage (HL docs)."""
        return 1.0 / (2.0 * self.exchange_max_leverage)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["maint_rate"] = self.maint_rate
        return d


def hip3_fee_multiplier(deployer_fee_scale: float, growth_mode: bool) -> float:
    """Fee multiplier for HIP-3 perps relative to validator-operated perps.

    Per HL docs: taker multiplier = scale + 1 if scale < 1 else 2 * scale;
    growth mode reduces all-in fees by 90 %.
    """
    s = max(0.0, deployer_fee_scale)
    mult = s + 1.0 if s < 1.0 else 2.0 * s
    if growth_mode:
        mult *= 0.1
    return mult


# Builder-dex markets that are crypto/commodity rather than equities.
_NON_EQUITY_HINTS = {"GOLD", "SILVER", "XYZ100", "ALUMINIUM", "COPPER", "OIL", "BRENT", "WTI", "NATGAS",
                     "EUR", "JPY", "GBP", "PLATINUM", "PALLADIUM"}


def build_specs(cfg: Config, metas: dict[str, dict]) -> dict[str, MarketSpec]:
    """Build specs for the configured assets from ``{dex: meta}`` (meta from metaAndAssetCtxs)."""
    index = {}
    for dex, meta in metas.items():
        for u in meta.get("universe", []):
            index[u["name"]] = (dex, u)
    specs: dict[str, MarketSpec] = {}
    for a in cfg.assets:
        if a.coin not in index:
            raise ValueError(f"Markt {a.coin} existiert nicht auf Hyperliquid (dex '{a.dex or 'main'}').")
        dex, u = index[a.coin]
        if u.get("isDelisted"):
            log.warning("%s ist delisted", a.coin)
        ex_max = int(u.get("maxLeverage", 1))
        note = ""
        if str(a.leverage).lower() == "max":
            lev = ex_max
        else:
            lev = int(a.leverage)
            if lev > ex_max:
                note = f"Hebel {lev}x > Börsenmaximum {ex_max}x → gedeckelt"
                log.warning("%s: %s", a.coin, note)
                lev = ex_max
            elif lev < ex_max:
                note = f"Achtung: {lev}x < Börsenmaximum {ex_max}x"
                log.warning("%s: %s", a.coin, note)
        growth = str(u.get("growthMode", "")).lower() == "enabled"
        scale = finite(u.get("deployerFeeScale", 1.0), 1.0)
        mult = 1.0
        if dex and cfg.fees.use_exchange_scaling:
            mult = hip3_fee_multiplier(scale, growth)
        symbol = a.symbol
        specs[a.coin] = MarketSpec(
            coin=a.coin, dex=dex, symbol=symbol, exchange_max_leverage=ex_max, leverage=lev,
            sz_decimals=int(u.get("szDecimals", 0)), only_isolated=bool(u.get("onlyIsolated", False)),
            growth_mode=growth, deployer_fee_scale=scale,
            taker_fee=cfg.fees.base_taker * mult, maker_fee=cfg.fees.base_maker * mult,
            is_equity=bool(dex) and symbol.upper() not in _NON_EQUITY_HINTS, note=note,
        )
    return specs


def offline_specs(cfg: Config) -> dict[str, MarketSpec]:
    """Specs without network access (simulation / tests): builder dex = equity, growth mode on."""
    specs = {}
    for a in cfg.assets:
        lev = 10 if str(a.leverage).lower() == "max" else int(a.leverage)
        mult = hip3_fee_multiplier(1.0, True) if a.dex else 1.0
        specs[a.coin] = MarketSpec(
            coin=a.coin, dex=a.dex, symbol=a.symbol, exchange_max_leverage=lev, leverage=lev,
            sz_decimals=2, only_isolated=bool(a.dex), growth_mode=bool(a.dex), deployer_fee_scale=1.0,
            taker_fee=cfg.fees.base_taker * mult, maker_fee=cfg.fees.base_maker * mult,
            is_equity=bool(a.dex), note="offline",
        )
    return specs
