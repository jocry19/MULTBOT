"""Research lab: walk-forward backtest, Monte Carlo, signal decay, feature IC, correlations, funding."""
from __future__ import annotations

import asyncio
import json
import logging
import math

import numpy as np

from ..config import Config
from ..data.history import History, fetch_all
from ..exchange.hyperliquid import HLRest
from ..exchange.meta import MarketSpec, build_specs
from ..features.micro import MicroState
from ..learning.brain import Brain
from ..strategies.library import catalog
from ..util import DAY_MS, INTERVAL_MS, fmt_ts, now_ms
from .analytics import equity_metrics, hourly_profile, per_asset, per_regime, trade_metrics
from .backtest import BacktestResult, prepare_features, run_backtest
from .montecarlo import monte_carlo, monte_carlo_additive

log = logging.getLogger("multbot.research")


async def calibrate_costs(rest: HLRest, coins: list[str]) -> dict[str, dict]:
    """Measure current spread and ±2 % depth from live order books → cost model for backtests."""
    out = {}

    async def one(coin):
        try:
            book = await rest.l2_book(coin)
        except Exception as e:  # noqa: BLE001 – calibration is best effort
            log.warning("Orderbuch %s nicht verfügbar: %s", coin, e)
            return
        m = MicroState(coin)
        m.update_book(book.get("levels"), int(book.get("time", 0)))
        b, a = m.depth_usd(0.02)
        out[coin] = {"spread_bps": round(m.spread_bps(), 2), "depth_usd": round(b + a, 2),
                     "bid_depth": round(b, 2), "ask_depth": round(a, 2), "mid": m.mid,
                     "imbalance": round(m.imbalance(10), 3), "levels": len(m.bids) + len(m.asks)}

    await asyncio.gather(*(one(c) for c in coins))
    return out


def market_stats(history: dict[str, History], interval: str) -> dict[str, dict]:
    ims = INTERVAL_MS[interval]
    per_year = 365 * DAY_MS / ims
    out = {}
    for coin, h in history.items():
        if len(h.bars) < 10:
            continue
        c = np.array([b.c for b in h.bars])
        hi = np.array([b.h for b in h.bars])
        lo = np.array([b.l for b in h.bars])
        v = np.array([b.v for b in h.bars])
        r = np.diff(np.log(c))
        flat = ((hi - lo) <= 0) & (v <= 0)
        fr = h.funding_rate
        out[coin] = {
            "bars": len(c), "first": fmt_ts(h.bars[0].t), "last": fmt_ts(h.bars[-1].t), "last_px": float(c[-1]),
            "ret_total": float(c[-1] / c[0] - 1), "vol_ann": float(r.std() * math.sqrt(per_year)),
            "stale_frac": float(flat.mean()), "avg_range_bps": float(((hi - lo) / c).mean() * 1e4),
            "max_up_bar": float(r.max()) if len(r) else 0.0, "max_down_bar": float(r.min()) if len(r) else 0.0,
            "vol_base_total": float(v.sum()), "vol_usd_total": float((v * c).sum()),
            "funding_mean_h": float(fr.mean()) if len(fr) else 0.0,
            "funding_ann": float(fr.mean() * 24 * 365) if len(fr) else 0.0,
            "funding_std_h": float(fr.std()) if len(fr) else 0.0,
            "funding_pos_frac": float((fr > 0).mean()) if len(fr) else 0.0,
            "funding_last_h": float(fr[-1]) if len(fr) else 0.0,
            "kurtosis": float(((r - r.mean()) ** 4).mean() / (r.std() ** 4) - 3) if r.std() > 0 else 0.0,
        }
    return out


def correlation_matrix(history: dict[str, History], n: int = 2000) -> dict:
    coins = [c for c, h in history.items() if len(h.bars) > 50]
    rets = {}
    for c in coins:
        bars = history[c].bars[-n:]
        closes = {b.t: b.c for b in bars}
        rets[c] = closes
    m = []
    for a in coins:
        row_ = []
        for b in coins:
            if a == b:
                row_.append(1.0)
                continue
            common = sorted(set(rets[a]) & set(rets[b]))
            if len(common) < 50:
                row_.append(0.0)
                continue
            x = np.diff(np.log([rets[a][t] for t in common]))
            y = np.diff(np.log([rets[b][t] for t in common]))
            ok = (x != 0) | (y != 0)
            x, y = x[ok], y[ok]
            row_.append(float(np.corrcoef(x, y)[0, 1]) if len(x) > 20 and x.std() > 0 and y.std() > 0 else 0.0)
        m.append([round(v, 3) for v in row_])
    return {"coins": coins, "m": m}


def build_report(cfg: Config, specs: dict[str, MarketSpec], history: dict[str, History], res: BacktestResult,
                 brain: Brain, calib: dict, label: str = "research") -> dict:
    ims = INTERVAL_MS[cfg.signal.interval]
    oos_eq = [e for e in res.equity if e[0] >= res.train_end_t]
    oos_trades = [t for t in res.trades if t["entry_ms"] >= res.train_end_t]
    if cfg.account.fixed:
        mc = monte_carlo_additive(oos_trades or res.trades, cfg.reference_capital, cfg.research.mc_paths,
                                  cfg.research.mc_trades)
    else:
        mc = monte_carlo(oos_trades or res.trades, cfg.account.starting_balance, cfg.research.mc_paths,
                         cfg.research.mc_trades)
    step = max(1, len(res.equity) // 2000)
    return {
        "label": label, "generated": now_ms(), "interval": cfg.signal.interval,
        "period": {"start": res.start_t, "end": res.end_t, "train_end": res.train_end_t, "bars": res.bars,
                   "elapsed_s": round(res.elapsed_s, 1)},
        "config": {"starting_balance": cfg.reference_capital, "mode": cfg.account.mode,
                   "position_margin_usd": cfg.account.position_margin_usd,
                   "max_open_positions": cfg.risk.max_open_positions, "train_frac": cfg.research.train_frac,
                   "leverage": {c: s.leverage for c, s in specs.items()},
                   "taker_fee": {c: s.taker_fee for c, s in specs.items()}},
        "metrics_oos": equity_metrics(oos_eq, ims), "metrics_all": equity_metrics(res.equity, ims),
        "trades_oos": trade_metrics(oos_trades), "trades_all": trade_metrics(res.trades),
        "per_asset": per_asset(oos_trades or res.trades), "per_regime": per_regime(oos_trades or res.trades),
        "hourly": hourly_profile(oos_trades or res.trades),
        "account": res.account, "counters": res.counters, "rejects": res.rejects,
        "equity": res.equity[::step], "trades": res.trades[-600:], "monte_carlo": mc,
        "brain": brain.snapshot(), "strategies": catalog(),
        "market": market_stats(history, cfg.signal.interval), "correlation": correlation_matrix(history),
        "costs": calib, "specs": {c: s.to_dict() for c, s in specs.items()},
        "journal": res.journal[-300:],
    }


def select_markets(specs: dict[str, MarketSpec], top: int = 0, coins: list[str] | None = None) -> dict:
    """Research universe: explicit coins, else the ``top`` markets by 24h volume (0 = all)."""
    if coins:
        wanted = {c.strip() for c in coins if c.strip()}
        alias = {s.symbol.upper(): c for c, s in specs.items()}
        picked = [c if c in specs else alias.get(c.upper()) for c in wanted]
        return {c: specs[c] for c in specs if c in picked}
    if top and len(specs) > top:
        keep = set(sorted(specs, key=lambda c: -specs[c].day_volume)[:top])
        return {c: s for c, s in specs.items() if c in keep}
    return specs


async def run_research(cfg: Config, interval: str | None = None, n_bars: int | None = None,
                       out_name: str = "research_latest.json", progress=None, top: int | None = None,
                       coins: list[str] | None = None) -> dict:
    if interval:
        cfg.signal.interval = interval
    rest = HLRest(cfg.api_url)
    try:
        metas, ctxs = {}, {}
        for dex in cfg.dexes:
            metas[dex], ctxs[dex] = await rest.meta_and_ctxs(dex)
        specs = select_markets(build_specs(cfg, metas, ctxs), cfg.research.max_markets if top is None else top, coins)
        log.info("Research-Universum: %d Märkte", len(specs))
        history = await fetch_all(cfg, rest, cfg.signal.interval, n_bars or cfg.learning.history_bars,
                                  coins=list(specs))
        calib = await calibrate_costs(rest, list(specs))
    finally:
        await rest.close()
    brain = Brain(cfg, list(specs))
    prepared = prepare_features(history, specs, cfg.signal.interval, cfg.signal.use_lead_lag)
    res = await asyncio.to_thread(run_backtest, cfg, specs, history, brain, calib, None, True, False, progress,
                                  prepared)
    report = build_report(cfg, specs, history, res, brain, calib)
    path = cfg.data_path("research", out_name)
    path.write_text(json.dumps(report, default=_default))
    report["_path"] = str(path)
    return report


def _default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (set, tuple)):
        return list(o)
    raise TypeError(type(o))


def print_summary(rep: dict) -> None:
    def pct(x):
        return "-" if x is None else f"{x * 100:+.2f}%"

    p = rep["period"]
    print("\n══════════════ MULTBOT RESEARCH ══════════════")
    print(f"Zeitraum   {fmt_ts(p['start'])} → {fmt_ts(p['end'])}  ({p['bars']} Bars {rep['interval']}, "
          f"{p['elapsed_s']}s)")
    print(f"Lernphase  bis {fmt_ts(p['train_end'])} (nur lernen), danach out-of-sample handeln")
    m, tr = rep.get("metrics_oos") or {}, rep.get("trades_oos") or {}
    cf = rep.get("config", {})
    if cf.get("mode") == "fixed" and tr.get("n"):
        print(f"\nModus      jede Position {cf.get('position_margin_usd', 100):.0f} USD Margin × max. Hebel, "
              + (f"max. {cf['max_open_positions']} offen" if cf.get("max_open_positions") else
                 "beliebig viele offen (gerankt nach erwarteter Rendite)") + ", Kapital unbegrenzt")
        print(f"OOS-PnL    {tr['net']:+.2f} USD  (Ø {tr['expectancy']:+.2f} USD/Trade, "
              f"{tr['net'] / max(cf.get('starting_balance', 500), 1) * 100:+.1f}% auf {cf.get('starting_balance', 500):.0f} USD Referenz)")
    print(f"\nOOS        Rendite {pct(m.get('chained_return'))}  Sharpe {m.get('sharpe', 0):.2f}  "
          f"Sortino {m.get('sortino', 0):.2f}  MaxDD {pct(m.get('max_dd'))}  Epochen {m.get('epochs', 1)}")
    if tr.get("n"):
        pf = tr.get("profit_factor")
        print(f"Trades     {tr['n']}  Trefferquote {tr['win_rate'] * 100:.1f}%  PF {pf if pf is None else round(pf, 2)}"
              f"  Ø R {tr['avg_r']:+.2f}  Netto {tr['net']:+.2f} USD  Liquidationen {tr['liquidations']}")
        print(f"Kosten     Gebühren {tr['fees']:.2f} USD  Funding {tr['funding']:+.2f} USD")
        print(f"Exits      {tr['reasons']}")
    mc = rep.get("monte_carlo", {})
    if mc.get("ok"):
        fp = mc["final_pct"]
        if mc.get("mode") == "fixed":
            fp = mc["final_pct"]
            print(f"\nMonte Carlo ({mc['n_paths']} Pfade × {mc['n_trades']} Trades à 100 USD): P(Gewinn) "
                  f"{mc['p_profit'] * 100:.1f}%  Median-PnL {fp['50']:+.2f} USD  [5%: {fp['5']:+.2f} | 95%: "
                  f"{fp['95']:+.2f}]  Median-MaxDD {mc['median_max_dd']:.2f} USD")
        else:
            print(f"\nMonte Carlo ({mc['n_paths']} Pfade × {mc['n_trades']} Trades): P(Ruin) {mc['p_ruin'] * 100:.1f}%  "
                  f"P(Gewinn) {mc['p_profit'] * 100:.1f}%  Median-Ende {fp['50']:.2f} USD  [5%: {fp['5']:.2f} | "
                  f"95%: {fp['95']:.2f}]")
    else:
        print(f"\nMonte Carlo: {mc.get('reason')}")
    print("\nPro Markt (OOS):")
    for coin, s in sorted(rep.get("per_asset", {}).items(), key=lambda kv: -kv[1]["net"]):
        print(f"  {coin:<10} n={s['n']:<4} netto {s['net']:+8.2f}  Treffer {s['win_rate'] * 100:5.1f}%  "
              f"ØR {s['avg_r']:+.2f}  Liq {s['liquidations']}")
    print("\nStrategien (Hit-Rate / IC @ Horizont / Gewicht):")
    b = rep["brain"]
    for s in sorted(b["strategies"], key=lambda r: -(r["ic"] or 0)):
        hit = "-" if s["hit"] is None else f"{s['hit'] * 100:5.1f}%"
        w = "-" if s["weight"] is None else f"{s['weight'] * 100:5.1f}%"
        print(f"  {s['key']:<12} n={s['n']:<6} hit {hit}  IC {s['ic']:+.3f} (t {s['t']:+.1f})  w {w}"
              f"{'  [STUMM]' if s['muted'] else ''}")
    print(f"\nML: n={b['ml']['n']} Brier {b['ml']['brier']:.4f} Acc {b['ml']['acc'] * 100:.1f}%   "
          f"Meta: n={b['meta']['n']} Brier {b['meta']['brier']:.4f}")
    print("\nMärkte:")
    for coin, s in rep.get("market", {}).items():
        print(f"  {coin:<10} Vola p.a. {s['vol_ann'] * 100:6.1f}%  eingefroren {s['stale_frac'] * 100:4.0f}%  "
              f"Funding p.a. {s['funding_ann'] * 100:+7.2f}%  Spread {rep['costs'].get(coin, {}).get('spread_bps', '-')} bps")
    print(f"\nReport gespeichert: {rep.get('_path')}")
