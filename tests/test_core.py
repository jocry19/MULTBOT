import json
import math

import numpy as np
import pytest

from multbot.config import load_config
from multbot.data.bars import Bar
from multbot.data.history import History
from multbot.engine.account import Account, Position
from multbot.engine.engine import Engine
from multbot.engine.execution import ExecutionModel
from multbot.engine.risk import RiskManager, liq_price
from multbot.engine.sim import SyntheticMarket
from multbot.exchange.meta import build_specs, hip3_fee_multiplier, offline_specs
from multbot.features.micro import MicroState
from multbot.features.pipeline import ML_FEATURES, compute_features, row
from multbot.learning.brain import Brain
from multbot.learning.hedge import Hedge
from multbot.learning.online_lr import OnlineLogit
from multbot.learning.stats import BetaArm, EWCorr
from multbot.research.backtest import run_backtest
from multbot.research.montecarlo import monte_carlo
from multbot.strategies.library import STRATEGIES, evaluate_all


@pytest.fixture()
def cfg(tmp_path):
    return load_config(None, {"data_dir": str(tmp_path)})


def make_pos(side=1, entry=100.0, lev=10, max_lev=10, notional=1000.0):
    size = notional / entry
    margin = notional / lev
    return Position(coin="X", side=side, size=size, entry_px=entry, leverage=lev, maint_rate=1 / (2 * max_lev),
                    margin=margin, init_margin=margin, opened_ms=0, stop_px=entry * (1 - side * 0.02),
                    tp_px=entry * (1 + side * 0.04), init_stop_px=entry * (1 - side * 0.02), entry_fee=0.45, atr=1.0)


# ── account / liquidation math ───────────────────────────────────────────────
def test_liq_price_matches_hyperliquid_formula():
    for side in (1, -1):
        p = make_pos(side=side)
        l = p.maint_rate
        mm_req = p.size * p.entry_px * l
        hl = p.entry_px - side * (p.margin - mm_req) / p.size / (1 - l * side)
        assert p.liq_price() == pytest.approx(hl, rel=1e-12)
        # at the liquidation price the isolated equity equals maintenance margin
        lp = p.liq_price()
        assert p.equity(lp) == pytest.approx(p.maint_margin(lp), rel=1e-9)


def test_liq_distance_at_max_leverage():
    long10 = make_pos(side=1, lev=10, max_lev=10)
    assert long10.liq_distance(100.0) == pytest.approx(1 - 0.9 / 0.95, rel=1e-9)  # ≈ 5.26 %
    long3 = make_pos(side=1, lev=3, max_lev=3)
    assert long3.liq_distance(100.0) == pytest.approx(1 - (2 / 3) / (1 - 1 / 6), rel=1e-9)  # 20 %


def test_isolated_loss_capped_and_accounting():
    acc = Account(200.0)
    p = make_pos()
    acc.open(p)
    assert acc.balance == pytest.approx(200 - p.margin - p.entry_fee)
    tr = acc.close("X", 50.0, 0.1, "test", 1, liquidation=True)   # price halves: loss > margin
    assert tr["net"] == pytest.approx(-p.init_margin - p.entry_fee)
    assert acc.balance >= 0
    assert acc.liquidations == 1


def test_funding_direction():
    acc = Account(1000.0)
    acc.open(make_pos(side=1))
    paid = acc.apply_funding("X", 0.0001, 100.0)
    assert paid > 0                       # longs pay positive funding
    assert acc.positions["X"].margin < acc.positions["X"].init_margin
    acc2 = Account(1000.0)
    acc2.open(make_pos(side=-1))
    assert acc2.apply_funding("X", 0.0001, 100.0) < 0   # shorts receive


def test_round_trip_pnl_identity():
    acc = Account(100.0)
    acc.open(make_pos(side=1, notional=500.0, lev=10))
    tr = acc.close("X", 102.0, 0.2, "tp", 1)
    assert tr["pnl"] == pytest.approx(5.0 * 2.0)
    assert acc.balance == pytest.approx(100 + tr["net"])


# ── fees / specs ─────────────────────────────────────────────────────────────
def test_hip3_fee_multiplier():
    assert hip3_fee_multiplier(1.0, False) == pytest.approx(2.0)
    assert hip3_fee_multiplier(1.0, True) == pytest.approx(0.2)
    assert hip3_fee_multiplier(0.5, False) == pytest.approx(1.5)


def test_build_specs_uses_max_leverage_and_clamps(cfg):
    cfg.assets = cfg.assets[:2]
    cfg.assets[0].leverage = 50
    metas = {
        "xyz": {"universe": [{"name": "xyz:GEV", "maxLeverage": 10, "szDecimals": 3, "onlyIsolated": True,
                              "growthMode": "enabled", "deployerFeeScale": "1.0"}]},
        "": {"universe": [{"name": "HMSTR", "maxLeverage": 3, "szDecimals": 0}]},
    }
    specs = build_specs(cfg, metas)
    assert specs["xyz:GEV"].leverage == 10            # clamped to exchange max
    assert specs["HMSTR"].leverage == 3
    assert specs["xyz:GEV"].taker_fee == pytest.approx(0.00045 * 0.2)
    assert specs["HMSTR"].taker_fee == pytest.approx(0.00045)
    assert specs["xyz:GEV"].maint_rate == pytest.approx(0.05)


# ── execution ────────────────────────────────────────────────────────────────
def test_book_walk_vwap(cfg):
    specs = offline_specs(cfg)
    coin = cfg.coins[0]
    m = MicroState(coin)
    m.update_book([[{"px": "99", "sz": "1"}, {"px": "98", "sz": "5"}],
                   [{"px": "101", "sz": "1"}, {"px": "102", "sz": "5"}]], 10**13)
    cfg.execution.extra_slippage_bps = 0.0
    ex = ExecutionModel(cfg, specs, {coin: m})
    fill = ex.market(coin, 1, 3.0, 100.0, 10**13)
    assert fill.px == pytest.approx((101 * 1 + 102 * 2) / 3)
    assert fill.source == "book"
    assert ex.maker_price(coin, 1, 100.0, 10**13) == 99.0
    assert ex.maker_price(coin, -1, 100.0, 10**13) == 101.0


def test_risk_stop_always_before_liquidation(cfg):
    specs = offline_specs(cfg)
    spec = specs[cfg.coins[0]]
    rm = RiskManager(cfg)
    for atr in (0.01, 0.5, 2.0, 20.0):
        order, why = rm.size(spec, 1, 100.0, atr, 100.0, 100.0, 0.6, None, 10.0, 1e6)
        if order is None:
            continue
        assert order.stop_px > order.liq_px
        assert order.margin * order.leverage == pytest.approx(order.notional, rel=1e-6)
        assert order.leverage == spec.leverage
    assert liq_price(100, 1, 10, 10, 0.05) == pytest.approx((100 - 1) / 0.95)


# ── learning ─────────────────────────────────────────────────────────────────
def test_hedge_rewards_shift_weight():
    h = Hedge(["a", "b"], eta=0.1, floor=0.01)
    for _ in range(50):
        h.update({"a": 1.0, "b": -1.0})
    w = h.weights()
    assert w["a"] > 0.9 and w["b"] >= 0.01


def test_online_logit_learns():
    rng = np.random.default_rng(0)
    m = OnlineLogit(["x1", "x2"], lr=0.1, l2=0.0)
    for _ in range(3000):
        x = rng.normal(size=2)
        m.update(x, 1.0 if x[0] - 0.5 * x[1] > 0 else 0.0)
    assert m.accuracy() > 0.85
    assert m.w[0] > 0 > m.w[1]


def test_ewcorr_matches_numpy_on_long_halflife():
    rng = np.random.default_rng(1)
    x = rng.normal(size=2000)
    y = 0.3 * x + rng.normal(size=2000)
    c = EWCorr(halflife=1e9)
    for a, b in zip(x, y):
        c.add(a, b)
    assert c.corr == pytest.approx(np.corrcoef(x, y)[0, 1], abs=1e-6)


def test_beta_arm():
    arm = BetaArm(decay=1.0)
    for i in range(100):
        arm.update(i % 4 != 0)
    assert arm.mean == pytest.approx(76 / 102)
    assert arm.prob_above(0.5) > 0.99


# ── features / strategies ────────────────────────────────────────────────────
def _synthetic_arrays(n=800, drift=0.0005, seed=3):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(drift + rng.normal(0, 0.004, n)))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * (1 + rng.uniform(0, 0.002, n))
    l = np.minimum(o, c) * (1 - rng.uniform(0, 0.002, n))
    t = (np.arange(n) * 300_000 + 1_700_000_000_000).astype(np.int64)
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": rng.uniform(0, 10, n), "n": np.ones(n)}


def test_features_finite_and_aligned():
    a = _synthetic_arrays()
    f = compute_features(a, 300_000, np.full(len(a["c"]), 1e-5), np.zeros(len(a["c"])))
    for k, v in f.items():
        assert len(v) == len(a["c"]), k
        assert np.all(np.isfinite(v)), k
    # persistent uptrend → on average positive Kalman drift and EMA spread
    assert f["kf_slope_z"][-400:].mean() > 0
    assert f["ema_spread"][-400:].mean() > 0
    assert set(row(f)) == set(f)


def test_features_are_causal():
    """Appending future bars must not change past feature values (no look-ahead)."""
    a = _synthetic_arrays(900)
    cut = 700
    short = {k: v[:cut] for k, v in a.items()}
    f_full = compute_features(a, 300_000)
    f_short = compute_features(short, 300_000)
    for k in ("ema_spread", "rsi_14", "bb_z", "kf_slope_z", "atr", "macd_hist_z", "don_break", "hurst"):
        assert f_full[k][cut - 1] == pytest.approx(f_short[k][cut - 1], rel=1e-9, abs=1e-12), k


def test_lead_lag_features_are_causal():
    """Lead-lag features use only the leader's past closes; the follower lags the leader by one bar."""
    from multbot.features.pipeline import align_leader
    lead = _synthetic_arrays(900, seed=5)
    a = _synthetic_arrays(900, seed=6)
    a["c"] = np.r_[100.0, 100 * lead["c"][:-1] / lead["c"][0]]          # follows the leader one bar late
    lead_c = align_leader(a["t"], lead["t"], lead["c"])
    assert np.allclose(lead_c, lead["c"])
    cut = 700
    f_full = compute_features(a, 300_000, lead=lead_c)
    f_short = compute_features({k: v[:cut] for k, v in a.items()}, 300_000, lead=lead_c[:cut])
    for k in ("lead_ret_1", "lead_ret_3", "lead_beta", "lag_gap"):
        assert np.all(np.isfinite(f_full[k])), k
        assert f_full[k][cut - 1] == pytest.approx(f_short[k][cut - 1], rel=1e-9, abs=1e-12), k
    nxt = np.log(a["c"][2:] / a["c"][1:-1])                              # next bar's return of the follower
    assert np.corrcoef(f_full["lead_ret_1"][1:-1][300:], nxt[300:])[0, 1] > 0.9
    assert f_full["lead_beta"][-1] == pytest.approx(0.0, abs=0.2)        # same-bar beta ≈ 0 for a pure lag


def test_strategy_scores_bounded():
    a = _synthetic_arrays(600, drift=-0.001)
    f = compute_features(a, 300_000)
    for i in range(200, 600, 7):
        for key, (s, why) in evaluate_all(row(f, i)).items():
            assert -1.0 <= s <= 1.0, key
            assert isinstance(why, str)
    assert len(STRATEGIES) >= 19


# ── end to end ───────────────────────────────────────────────────────────────
def test_backtest_end_to_end_accounting(cfg):
    cfg.signal.warmup_bars = 120
    cfg.account.restart_on_ruin = False
    specs = offline_specs(cfg)
    market = SyntheticMarket(list(specs), 300_000, seed=9)
    hist = market.history(1_700_000_000_000, 700, sub_steps=6)
    brain = Brain(cfg, list(specs))
    res = run_backtest(cfg, specs, hist, brain, market.calibration(), train_frac=0.3)
    assert brain.n_resolved > 1000
    assert res.counters["bars"] > 0
    # all positions are flat at the end → equity == start + Σ net (single epoch)
    if res.account["epoch"] == 1:
        assert res.account["equity"] == pytest.approx(res.account["start"] + sum(t["net"] for t in res.trades),
                                                      abs=1e-6)
        assert res.account["pnl"] == pytest.approx(sum(t["net"] for t in res.trades), abs=1e-6)
    for t in res.trades:
        assert t["leverage"] == specs[t["coin"]].leverage    # always max leverage


def test_brain_persistence_roundtrip(cfg, tmp_path):
    specs = offline_specs(cfg)
    b = Brain(cfg, list(specs))
    b.hedge_global.update({"ema_trend": 1.0})
    b.ml.update(np.ones(len(b.ml.names)), 1.0)
    path = tmp_path / "brain.json"
    b.save(path)
    b2 = Brain(cfg, list(specs))
    assert b2.load_file(path)
    assert b2.hedge_global.logw["ema_trend"] == pytest.approx(b.hedge_global.logw["ema_trend"])
    assert b2.ml.n == 1


def test_engine_liquidation_in_tick_mode(cfg):
    specs = offline_specs(cfg)
    coin = cfg.coins[0]
    eng = Engine(cfg, specs, Brain(cfg, list(specs)), mode="backtest")
    p = make_pos(side=1, entry=100.0, lev=specs[coin].leverage, max_lev=specs[coin].exchange_max_leverage,
                 notional=500.0)
    p.coin = coin
    p.stop_px = 1.0  # disable stop to force a liquidation
    eng.account.open(p)
    eng.last_px[coin] = 100.0
    eng.on_price(coin, p.liq_price() * 0.999, 1)
    assert coin not in eng.account.positions
    assert eng.account.liquidations == 1


def test_monte_carlo_shapes():
    trades = [{"net": n, "eq_entry": 100.0, "margin": 20.0} for n in np.random.default_rng(0).normal(0.5, 3, 80)]
    mc = monte_carlo(trades, 100.0, n_paths=500, n_trades=50)
    assert mc["ok"] and 0 <= mc["p_ruin"] <= 1
    assert len(mc["fan"]["50"]) == len(mc["fan_steps"])


def test_bar_from_hl():
    b = Bar.from_hl({"t": 1, "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "3", "n": 4})
    assert (b.t, b.h, b.n) == (1, 2.0, 4)


def test_history_funding_alignment():
    h = History("X", "5m", [], np.array([0, 3_600_000], dtype=np.int64), np.array([0.1, 0.2]), np.array([0.0, 0.0]))
    fr, _ = h.funding_aligned(np.array([-1, 10, 3_600_000, 4_000_000]))
    assert list(fr) == [0.0, 0.1, 0.2, 0.2]
    assert math.isclose(fr[1], 0.1)


# ── large-universe additions ─────────────────────────────────────────────────
def test_parse_assets_compact_and_dedup():
    from multbot.config import parse_assets
    out = parse_assets(["BTC", "xyz:TSLA", {"coin": "ETH", "leverage": 5}, "BTC"], "max")
    assert [a.coin for a in out] == ["BTC", "xyz:TSLA", "ETH"]
    assert out[0].leverage == "max" and out[2].leverage == 5


def test_build_specs_skips_unknown_and_resolves_dex(cfg):
    from multbot.config import AssetCfg
    cfg.assets = [AssetCfg("BTC"), AssetCfg("NOPE"), AssetCfg("TSLA")]
    metas = {"": {"universe": [{"name": "BTC", "maxLeverage": 40, "szDecimals": 5}]},
             "xyz": {"universe": [{"name": "xyz:TSLA", "maxLeverage": 20, "szDecimals": 3}]}}
    specs = build_specs(cfg, metas)
    assert set(specs) == {"BTC", "xyz:TSLA"}
    assert specs["BTC"].leverage == 40 and specs["xyz:TSLA"].asset_class == "equity"


def test_activity_profile_is_causal_and_learns_hours():
    from multbot.features.pipeline import activity_profile
    t = (np.arange(24 * 12 * 14) * 300_000 + 1_700_006_400_000).astype(np.int64)   # 14 days of 5m bars
    hours = (t // 3_600_000) % 24
    active = ((hours >= 14) & (hours < 21)).astype(float)                           # "US session" only
    prof = activity_profile(t, active)
    assert prof[0] == 0.5                                                            # no look-ahead at start
    late = slice(len(t) - 24 * 12, None)
    assert prof[late][active[late] == 1].mean() > 0.8
    assert prof[late][active[late] == 0].mean() < 0.2
    cut = 2000
    assert activity_profile(t[:cut], active[:cut])[-1] == pytest.approx(prof[cut - 1])


def test_cluster_cap_blocks_same_class_side(cfg):
    from multbot.features.regime import Regime
    cfg.risk.max_same_class_side = 2
    specs = offline_specs(cfg)
    eng = Engine(cfg, specs, Brain(cfg, list(specs)), mode="backtest")
    eq_coins = [c for c, s in specs.items() if s.asset_class == "equity"][:3]
    for c in eq_coins[:2]:
        p = make_pos(side=1, notional=20.0)
        p.coin = c
        eng.account.open(p)
    d = {"agreement": 1.0}
    ok, code, _ = eng._entry_checks(eq_coins[2], specs[eq_coins[2]], 0.9, d, None,
                                    Regime("TREND", "MID", 1, True), {"funding_h": 0.0}, 0)
    assert not ok and code == "Klumpenrisiko"


def test_barseries_merge_keeps_live_bars():
    from multbot.data.bars import BarSeries
    s = BarSeries(maxlen=10)
    s.upsert(Bar(30, 1, 1, 1, 9.0))
    s.merge([Bar(10, 1, 1, 1, 1.0), Bar(20, 1, 1, 1, 2.0), Bar(30, 1, 1, 1, 3.0)])
    assert s.cols["t"] == [10, 20, 30] and s.cols["c"] == [1.0, 2.0, 9.0]


def test_fixed_mode_every_position_same_margin(cfg):
    """Fixed mode: unlimited capital, each position = 100 USD margin at max leverage, any number open."""
    assert cfg.account.fixed and cfg.account.position_margin_usd == 100 and not cfg.risk.max_open_positions
    assert cfg.reference_capital == 1000
    cfg.risk.max_open_positions = 5
    assert cfg.reference_capital == 500
    specs = offline_specs(cfg)
    spec = specs[cfg.coins[0]]
    order, why = RiskManager(cfg).size(spec, 1, 50.0, 0.2, equity=-1000.0, free_balance=0.0, final=0.9, pwin=0.9,
                                       spread_bps=5.0, depth_usd=1e7)
    assert order is not None, why
    assert order.margin == pytest.approx(100.0, rel=0.02) and order.leverage == spec.leverage
    acc = Account(500.0, unlimited=True)
    for i in range(8):                      # far more margin than the reference capital – allowed
        p = make_pos(notional=1000.0)
        p.coin = f"C{i}"
        acc.open(p)
    assert acc.balance < 0


def test_monte_carlo_additive():
    from multbot.research.montecarlo import monte_carlo_additive
    trades = [{"net": n} for n in np.random.default_rng(1).normal(2.0, 10.0, 60)]
    mc = monte_carlo_additive(trades, 500.0, n_paths=400, n_trades=100)
    assert mc["ok"] and mc["mode"] == "fixed"
    assert mc["final_pct"]["50"] > 0 and 0 <= mc["p_profit"] <= 1


def test_history_cache_refetches_missing_older_range(cfg, tmp_path):
    """A cache that starts later than the requested window must not hide the older bars."""
    import asyncio
    import json as _json
    from multbot.data import history as hmod

    calls = []

    class FakeRest:
        async def candles(self, coin, interval, start, end):
            calls.append(start)
            step = 300_000
            return [{"t": t, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0, "n": 0}
                    for t in range(start - start % step, end - step, step)]

        async def funding_history(self, coin, start, end=None):
            return []

    now = hmod.now_ms()
    recent = [{"t": t, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0, "n": 0}
              for t in range(now - 100 * 300_000, now - 300_000, 300_000)]
    hmod._cache_file(cfg, "BTC", "5m").write_text(_json.dumps(recent))
    h = asyncio.run(hmod.fetch_history(cfg, FakeRest(), "BTC", "5m", 1000, with_funding=False))
    assert calls and calls[0] <= now - 999 * 300_000          # fetched from the requested start
    assert len(h.bars) >= 990


def test_expected_move_table_learns_per_bucket(cfg):
    """The expected favourable move is learned per |score| × volatility bucket, shrunk to the pooled mean."""
    brain = Brain(cfg, ["A"])
    assert brain.expected_move(0.3, 0.001) == pytest.approx(2.5e-4)     # nothing learned yet: cautious prior
    rng = np.random.default_rng(0)
    for _ in range(6000):
        sc, vol = rng.choice([0.3, 0.7]), 0.001
        fav = (0.0006 if sc < 0.5 else -0.0004) + rng.normal(0, 0.002)   # strong signals revert
        brain.move.add(fav)
        brain._move_cell(sc, vol).add(fav)
    for _ in range(3000):                                               # live pre-training never feeds the table
        brain.observe("A", 0, 100.0, 0.001, "TREND-HIGH", {"scores": {}, "ens": 0.5, "final": 0.5, "p_up": 0.6,
                      "x": np.zeros(len(ML_FEATURES))}, {}, None, 1, 0.0, pretrain=True)
    n0 = brain.move.n
    for i in range(brain.H):
        brain.on_bar("A", 100.0 * (1 + 0.01 * (i + 1)), i)
    assert brain.move.n == n0
    mid, strong = brain.expected_move(0.3, 0.001), brain.expected_move(-0.7, 0.001)
    assert mid > 0.0003 and strong < 0 and mid > strong
    assert brain.expected_move(0.3, 0.02) == pytest.approx(brain._pooled_move())   # empty bucket → pooled
    d = brain.to_dict()
    b2 = Brain(cfg, ["A"])
    from multbot.learning.brain import _json_default
    b2.load(json.loads(json.dumps(d, default=_json_default)))
    assert b2.expected_move(0.3, 0.001) == pytest.approx(mid)


def test_entries_ranked_by_expected_roe(cfg):
    """Candidates of one bar enter best-first; weak expected returns and the per-bar cap are rejected."""
    cfg.signal.max_new_per_bar = 2
    specs = offline_specs(cfg, 5)
    coins = list(specs)
    engine = Engine(cfg, specs, Brain(cfg, coins), mode="backtest")
    exp = dict(zip(coins, [0.01, 0.08, -0.02, 0.05, 0.03]))
    t = 1_700_000_000_000
    for c in coins:
        engine.last_analysis[c] = {"t": t, "frow": {}, "an": {"final": 0.6, "pwin": None, "exp_roe": exp[c]}}
    engine.entry_queue[t] = list(coins)
    order = []

    def fake_try(coin, spec, an, frow, t_):
        ok, code, why = engine._entry_checks(coin, spec, an["final"], {"agreement": 1.0}, None,
                                             type("R", (), {"tradable": True, "label": "TREND-HIGH"})(), {}, t_,
                                             an["exp_roe"])
        if ok:
            order.append(coin)
        return ok

    engine._try_entry = fake_try
    engine.exec.spread_bps = lambda coin, t_: 1.0
    assert engine.flush_entries() == 2
    assert order == [coins[1], coins[3]]                                # highest expected ROE first, cap 2
    assert not engine.entry_queue
    assert engine.last_analysis[coins[4]]["rank"] == (3, 5)
    assert engine.reject_reasons.get("Ranking") == 3
    cfg.signal.max_new_per_bar = None
    ok, code, _ = engine._entry_checks(coins[2], specs[coins[2]], 0.6, {"agreement": 1.0}, None,
                                       type("R", (), {"tradable": True, "label": "TREND-HIGH"})(), {}, t, -0.02)
    assert not ok and code == "Erwartung zu klein"
