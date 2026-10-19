"""Market specifications: leverage, size decimals, fee model and asset class per market."""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field

from ..config import Config
from ..util import finite

log = logging.getLogger("multbot.meta")

# informational classification of builder-dex markets (display + diagnostics only)
_FX = {"EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "CNH", "KRW"}
_COMMODITY = {"GOLD", "SILVER", "COPPER", "PLATINUM", "PALLADIUM", "CL", "BRENTOIL", "NATGAS", "HO", "ALUMINIUM",
              "OIL", "WTI", "BRENT", "URANIUM"}
_INDEX = {"XYZ100", "SP500", "JP225", "KR200", "NDX", "DJI", "HSI", "DAX"}
_ETF = {"SOXL", "EWY", "EWJ", "EWZ", "EWT", "SMH", "XLE", "URNM", "KORU", "MAGS", "XBI", "SPY", "QQQ"}

ASSET_CLASSES = ("crypto", "equity", "etf", "index", "commodity", "fx")


def asset_class(coin: str) -> str:
    if ":" not in coin:
        return "crypto"
    sym = coin.split(":", 1)[1].upper()
    if sym in _FX:
        return "fx"
    if sym in _COMMODITY:
        return "commodity"
    if sym in _INDEX:
        return "index"
    if sym in _ETF:
        return "etf"
    return "equity"


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
    asset_class: str = "crypto"
    day_volume: float = 0.0       # 24h notional volume at start (used for priorities)
    note: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def maint_rate(self) -> float:
        """Maintenance margin rate = half the initial margin at max leverage (HL docs)."""
        return 1.0 / (2.0 * self.exchange_max_leverage)

    @property
    def is_equity(self) -> bool:
        return self.asset_class in ("equity", "etf")

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


def build_specs(cfg: Config, metas: dict[str, dict], ctxs: dict[str, list] | None = None) -> dict[str, MarketSpec]:
    """Specs for the configured markets from ``{dex: meta}`` (and optional ``{dex: assetCtxs}``).

    Unknown or delisted markets are skipped with a warning instead of stopping the bot.
    """
    index: dict[str, tuple] = {}
    for dex, meta in metas.items():
        dex_ctxs = (ctxs or {}).get(dex) or []
        for i, u in enumerate(meta.get("universe", [])):
            index[u["name"]] = (dex, u, dex_ctxs[i] if i < len(dex_ctxs) else {})
    specs: dict[str, MarketSpec] = {}
    skipped: list[str] = []
    for a in cfg.assets:
        coin = a.coin
        if coin not in index:
            alt = coin.split(":", 1)[1] if ":" in coin else f"xyz:{coin}"
            if alt in index:
                log.info("%s → %s (Dex automatisch erkannt)", coin, alt)
                coin = alt
            else:
                skipped.append(f"{a.coin} (unbekannt)")
                continue
        if coin in specs:
            continue
        dex, u, ctx = index[coin]
        if u.get("isDelisted"):
            skipped.append(f"{coin} (delisted)")
            continue
        ex_max = int(u.get("maxLeverage", 1))
        note = ""
        if str(a.leverage).lower() == "max":
            lev = ex_max
        else:
            lev = int(a.leverage)
            if lev > ex_max:
                note = f"Hebel {lev}x > Börsenmaximum {ex_max}x → gedeckelt"
                lev = ex_max
            elif lev < ex_max:
                note = f"Achtung: {lev}x < Börsenmaximum {ex_max}x"
        growth = str(u.get("growthMode", "")).lower() == "enabled"
        scale = finite(u.get("deployerFeeScale", 1.0), 1.0)
        mult = hip3_fee_multiplier(scale, growth) if dex and cfg.fees.use_exchange_scaling else 1.0
        mult *= cfg.fees.discount
        specs[coin] = MarketSpec(
            coin=coin, dex=dex, symbol=coin.split(":", 1)[1] if ":" in coin else coin, exchange_max_leverage=ex_max,
            leverage=lev, sz_decimals=int(u.get("szDecimals", 0)), only_isolated=bool(u.get("onlyIsolated", False)),
            growth_mode=growth, deployer_fee_scale=scale, taker_fee=cfg.fees.base_taker * mult,
            maker_fee=cfg.fees.base_maker * mult, asset_class=asset_class(coin),
            day_volume=finite(ctx.get("dayNtlVlm"), 0.0), note=note,
        )
    if skipped:
        log.warning("%d Märkte übersprungen: %s", len(skipped), ", ".join(skipped[:30]))
    uc = cfg.universe
    if uc.min_day_volume_usd > 0:
        low = [c for c, s in specs.items() if s.day_volume < uc.min_day_volume_usd]
        for c in low:
            specs.pop(c)
        if low:
            log.info("%d Märkte unter %.0f USD Tagesvolumen ausgeblendet", len(low), uc.min_day_volume_usd)
    if uc.max_markets and len(specs) > uc.max_markets:
        keep = sorted(specs, key=lambda c: -specs[c].day_volume)[: uc.max_markets]
        specs = {c: specs[c] for c in specs if c in keep}
    if not specs:
        raise ValueError("Keiner der konfigurierten Märkte existiert auf Hyperliquid – config.yaml prüfen.")
    return specs


def offline_specs(cfg: Config, limit: int | None = None) -> dict[str, MarketSpec]:
    """Specs without network access (simulation / tests): builder dex markets with growth mode."""
    specs = {}
    for a in cfg.assets[: limit or None]:
        lev = 10 if str(a.leverage).lower() == "max" else int(a.leverage)
        mult = (hip3_fee_multiplier(1.0, True) if a.dex else 1.0) * cfg.fees.discount
        specs[a.coin] = MarketSpec(
            coin=a.coin, dex=a.dex, symbol=a.symbol, exchange_max_leverage=lev, leverage=lev,
            sz_decimals=2, only_isolated=bool(a.dex), growth_mode=bool(a.dex), deployer_fee_scale=1.0,
            taker_fee=cfg.fees.base_taker * mult, maker_fee=cfg.fees.base_maker * mult,
            asset_class=asset_class(a.coin), note="offline",
        )
    return specs
