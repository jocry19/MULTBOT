"""Performance analytics for equity curves and trade lists."""
from __future__ import annotations

import math
from collections import Counter, defaultdict

import numpy as np

YEAR_MS = 365 * 24 * 3600 * 1000


def equity_metrics(equity: list, interval_ms: int) -> dict:
    """equity: list of (t, equity, epoch). Epoch restarts (ruin → new 100 USD) are not counted as returns."""
    if len(equity) < 3:
        return {}
    t = np.array([e[0] for e in equity], dtype=float)
    eq = np.array([e[1] for e in equity], dtype=float)
    ep = np.array([e[2] for e in equity])
    prev = eq[:-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(prev > 0, eq[1:] / prev - 1, 0.0)
    r[ep[1:] != ep[:-1]] = 0.0
    r = np.nan_to_num(r)
    per_year = YEAR_MS / interval_ms
    mu, sd = r.mean(), r.std()
    downside = r[r < 0]
    dsd = math.sqrt((downside ** 2).mean()) if len(downside) else 0.0
    # drawdown on the chained (epoch-stitched) curve
    chain = np.cumprod(1 + r) * eq[0]
    peak = np.maximum.accumulate(chain)
    dd = 1 - chain / peak
    max_dd = float(dd.max())
    i_trough = int(dd.argmax())
    i_peak = int(np.argmax(chain[: i_trough + 1])) if i_trough else 0
    span_years = max((t[-1] - t[0]) / YEAR_MS, 1e-9)
    total = float(chain[-1] / chain[0] - 1)
    ann = (1 + total) ** (1 / span_years) - 1 if total > -1 and span_years > 0.02 else None
    return {
        "bars": len(eq), "start_equity": float(eq[0]), "end_equity": float(eq[-1]),
        "chained_return": total, "annualized": ann,
        "sharpe": float(mu / sd * math.sqrt(per_year)) if sd > 0 else 0.0,
        "sortino": float(mu / dsd * math.sqrt(per_year)) if dsd > 0 else 0.0,
        "vol_ann": float(sd * math.sqrt(per_year)),
        "max_dd": max_dd, "dd_peak_t": float(t[i_peak]), "dd_trough_t": float(t[i_trough]),
        "calmar": (ann / max_dd) if ann is not None and max_dd > 0 else None,
        "time_in_dd": float((dd > 0.001).mean()), "epochs": int(ep.max() - ep.min() + 1),
        "var95_bar": float(np.percentile(r, 5)), "cvar95_bar": float(r[r <= np.percentile(r, 5)].mean())
        if (r <= np.percentile(r, 5)).any() else 0.0,
    }


def trade_metrics(trades: list[dict]) -> dict:
    if not trades:
        return {"n": 0}
    net = np.array([t["net"] for t in trades], dtype=float)
    wins, losses = net[net > 0], net[net <= 0]
    gross_win, gross_loss = wins.sum(), -losses.sum()
    streak = mx = 0
    for x in net:
        streak = streak + 1 if x <= 0 else 0
        mx = max(mx, streak)
    rs = np.array([t.get("r_multiple", 0.0) for t in trades], dtype=float)
    hold = np.array([t.get("bars", 0) for t in trades], dtype=float)
    reasons = Counter(t["reason"] for t in trades)
    by_side = defaultdict(list)
    for t in trades:
        by_side["long" if t["side"] > 0 else "short"].append(t["net"])
    return {
        "n": len(trades), "net": float(net.sum()), "win_rate": float((net > 0).mean()),
        "avg_win": float(wins.mean()) if len(wins) else 0.0, "avg_loss": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else None,
        "expectancy": float(net.mean()), "avg_r": float(rs.mean()), "median_r": float(np.median(rs)),
        "payoff": float(wins.mean() / -losses.mean()) if len(wins) and len(losses) and losses.mean() < 0 else None,
        "max_consec_losses": int(mx), "avg_bars": float(hold.mean()),
        "fees": float(sum(t["fees"] for t in trades)), "funding": float(sum(t["funding"] for t in trades)),
        "liquidations": int(sum(1 for t in trades if t.get("liquidation"))),
        "reasons": dict(reasons.most_common()),
        "long": {"n": len(by_side["long"]), "net": float(sum(by_side["long"]))},
        "short": {"n": len(by_side["short"]), "net": float(sum(by_side["short"]))},
        "best": float(net.max()), "worst": float(net.min()),
    }


def per_asset(trades: list[dict]) -> dict[str, dict]:
    g = defaultdict(list)
    for t in trades:
        g[t["coin"]].append(t)
    out = {}
    for coin, ts in g.items():
        net = [t["net"] for t in ts]
        out[coin] = {"n": len(ts), "net": float(sum(net)), "win_rate": float(np.mean([x > 0 for x in net])),
                     "avg_r": float(np.mean([t.get("r_multiple", 0) for t in ts])),
                     "liquidations": int(sum(1 for t in ts if t.get("liquidation"))),
                     "fees": float(sum(t["fees"] for t in ts)), "funding": float(sum(t["funding"] for t in ts))}
    return out


def per_regime(trades: list[dict]) -> dict[str, dict]:
    g = defaultdict(list)
    for t in trades:
        g[t.get("regime") or "?"].append(t["net"])
    return {k: {"n": len(v), "net": float(sum(v)), "win_rate": float(np.mean([x > 0 for x in v]))}
            for k, v in g.items()}


def hourly_profile(trades: list[dict]) -> list[dict]:
    g = defaultdict(list)
    for t in trades:
        g[int((t["entry_ms"] // 3_600_000) % 24)].append(t["net"])
    return [{"hour": h, "n": len(g[h]), "net": float(sum(g[h]))} for h in range(24)]
