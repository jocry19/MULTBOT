"""The learning brain.

Every bar, every strategy's opinion on every asset is recorded as a *pending evaluation*
(whether or not a trade is opened). When the forward horizon has elapsed the brain learns:

* Hedge weights (global, per regime, per asset) – which strategies to trust where
* Beta posteriors of each strategy's hit rate – strategies that are reliably wrong get muted
* an online logistic model that predicts the direction of the next move from ~40 features
* a meta-label model that predicts whether a trade candidate beats its costs
* the expected move per unit of signal (pooled over all markets, shrunk per market) – used to rank entries
* information coefficients (IC) per strategy × horizon / regime / asset and per feature
* calibration tables and a learning curve
"""
from __future__ import annotations

import json
import logging
import math
from collections import deque
from pathlib import Path

import numpy as np

from ..config import Config
from ..features.pipeline import ML_FEATURES, ml_vector
from ..features.regime import REGIMES
from ..strategies.library import ALL_KEYS, ML_KEY, STRATEGY_KEYS
from .hedge import Hedge, blend_logw, softmax_floor
from .online_lr import OnlineLogit
from .stats import BetaArm, Calibration, EWCorr

log = logging.getLogger("multbot.brain")

META_FEATURES = ["abs_final", "agreement", "p_dir", "vol_pct", "spread", "stale", "session", "hurst_c", "adx_n",
                 "er_20", "funding_against", "side", "atr_bps", "trend", "range", "vol_high", "vol_low", "coverage"]

ENS = "ensemble"
FINAL = "final"


class Brain:
    VERSION = 4   # 4: learning horizon 12 bars, lead-lag features

    def __init__(self, cfg: Config, coins: list[str]):
        self.cfg = cfg
        lc, sc = cfg.learning, cfg.signal
        self.coins = list(coins)
        self.keys = list(ALL_KEYS)
        self.horizons = sorted(set(int(h) for h in sc.decay_horizons) | {int(sc.horizon)})
        self.H = int(sc.horizon)
        self.meta_h = min(max(self.horizons), self.H * 4)
        self.hedge_global = Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay)
        self.hedge_regime = {r: Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay) for r in REGIMES}
        self.hedge_asset = {c: Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay) for c in self.coins}
        self.ml = OnlineLogit(ML_FEATURES, lc.lr, lc.l2)
        self.meta = OnlineLogit(META_FEATURES, lc.lr, lc.l2)
        self.arms = {k: BetaArm() for k in self.keys + [FINAL]}
        track = self.keys + [ENS, FINAL]
        self.ic = {k: {h: EWCorr() for h in self.horizons} for k in track}
        self.ic_regime = {k: {r: EWCorr() for r in REGIMES} for k in track}
        self.ic_asset = {k: {c: EWCorr() for c in self.coins} for k in track}
        self.feat_ic = {f: EWCorr() for f in ML_FEATURES}
        self.move = EWCorr(halflife=20000)   # final score → vol-normalised forward return, all markets
        self.shadow = {k: 0.0 for k in track}
        self.counts = {k: [0, 0] for k in track}  # [n, hits]
        self.cal_ml = Calibration()
        self.cal_meta = Calibration()
        self.pending: dict[str, deque] = {c: deque() for c in self.coins}
        self.curve: list[dict] = []
        self.recent_final = deque(maxlen=300)
        self.n_resolved = 0
        self.n_observed = 0
        self.trained_until: dict[str, int] = {c: 0 for c in self.coins}
        self.muted: set[str] = set()
        self.last_t = 0

    # ── decision ──────────────────────────────────────────────────────────
    def weights(self, coin: str, regime: str) -> dict[str, float]:
        layers = [(self.hedge_global.logw, 1.0)]
        hr = self.hedge_regime.get(regime)
        if hr and hr.n:
            layers.append((hr.logw, min(1.0, hr.n / 300)))
        ha = self.hedge_asset.get(coin)
        if ha and ha.n:
            layers.append((ha.logw, min(1.0, ha.n / 300)))
        w = softmax_floor(blend_logw(layers), self.cfg.learning.hedge_floor)
        for k in self.muted | set(self.cfg.signal.disabled_strategies):
            if k in w:
                w[k] = 0.0
        s = sum(w.values()) or 1.0
        return {k: v / s for k, v in w.items()}

    @property
    def ml_ready(self) -> bool:
        return self.ml.n >= 200

    @property
    def meta_ready(self) -> bool:
        return self.meta.n >= self.cfg.learning.meta_min_samples

    def decide(self, coin: str, regime: str, scores: dict[str, float], frow: dict[str, float]) -> dict:
        x = ml_vector(frow)
        p_up = self.ml.predict(x)
        ml_score = max(-1.0, min(1.0, (p_up - 0.5) * 4.0)) if self.ml_ready else 0.0
        all_scores = dict(scores)
        all_scores[ML_KEY] = ml_score
        w = self.weights(coin, regime)
        off = self.muted | set(self.cfg.signal.disabled_strategies)
        rule_keys = [k for k in STRATEGY_KEYS if k not in off]
        w_rules = {k: w[k] for k in rule_keys}
        tot = sum(w_rules.values()) or 1.0
        active = {k: v for k, v in w_rules.items() if abs(all_scores[k]) > 0.05}
        wa = sum(active.values())
        raw = sum(v * all_scores[k] for k, v in active.items()) / wa if wa > 0 else 0.0
        coverage = wa / tot
        ens = raw * math.sqrt(coverage)
        blend = self.cfg.signal.ml_blend if self.ml_ready else 0.0
        final = (1 - blend) * ens + blend * ml_score
        sgn = 1 if final > 0 else -1 if final < 0 else 0
        mass = sum(w[k] * abs(all_scores[k]) for k in self.keys) or 1.0
        agree = sum(w[k] * abs(all_scores[k]) for k in self.keys
                    if sgn and (all_scores[k] > 0) == (sgn > 0) and abs(all_scores[k]) > 0.05) / mass
        contrib = sorted(((k, w[k] * all_scores[k] / tot) for k in self.keys if abs(all_scores[k]) > 0.05),
                         key=lambda kv: -abs(kv[1]))
        return {"scores": all_scores, "weights": w, "ens": ens, "final": final, "p_up": p_up,
                "ml_score": ml_score, "agreement": agree, "coverage": coverage, "contrib": contrib[:8], "x": x}

    def meta_vector(self, d: dict, frow: dict[str, float], side: int, regime_label: str) -> np.ndarray:
        trend, vol = regime_label.split("-")
        p_dir = d["p_up"] if side > 0 else 1 - d["p_up"]
        return np.array([
            abs(d["final"]), d["agreement"], p_dir, frow.get("vol_pct", 0.5), frow.get("spread_bps", 0.0) / 10,
            frow.get("stale", 0.0), frow.get("session", 1.0), frow.get("hurst_c", 0.0), frow.get("adx_n", 0.0),
            frow.get("er_20", 0.0), side * frow.get("funding_h", 0.0) * 1e4, float(side),
            frow.get("atr_pct", 0.0) * 1e4, float(trend == "TREND"), float(trend == "RANGE"),
            float(vol == "HIGH"), float(vol == "LOW"), d["coverage"],
        ], dtype=float)

    def p_win(self, meta_x: np.ndarray) -> float | None:
        return self.meta.predict(meta_x) if self.meta_ready else None

    # ── observation / resolution ─────────────────────────────────────────
    def observe(self, coin: str, t: int, px: float, vol: float, regime: str, d: dict, frow: dict[str, float],
                meta_x: np.ndarray | None, side: int, cost: float) -> None:
        self.pending[coin].append({
            "t": t, "px": px, "vol": max(vol, 1e-6), "regime": regime, "scores": d["scores"], "ens": d["ens"],
            "final": d["final"], "p_up": d["p_up"], "x": d["x"], "meta_x": meta_x, "side": side, "cost": cost,
            "age": 0,
        })
        self.n_observed += 1
        self.last_t = max(self.last_t, t)

    def on_bar(self, coin: str, close: float, t: int) -> int:
        """Advance the age of pending evaluations for ``coin`` and learn from those that matured."""
        q = self.pending.get(coin)
        if not q:
            return 0
        maxh = max(self.horizons)
        learned = 0
        for item in q:
            item["age"] += 1
            age = item["age"]
            if age in self.horizons or age == self.meta_h:
                ret = math.log(max(close, 1e-300) / max(item["px"], 1e-300))
                self._resolve(coin, item, age, ret, t)
                if age == self.H:
                    learned += 1
        while q and q[0]["age"] >= max(maxh, self.meta_h):
            q.popleft()
        self.trained_until[coin] = max(self.trained_until.get(coin, 0), t)
        return learned

    def _resolve(self, coin: str, it: dict, h: int, ret: float, t: int) -> None:
        flat = abs(ret) < 1e-9
        norm = max(-3.0, min(3.0, ret / (it["vol"] * math.sqrt(h))))
        scores = it["scores"]
        if h in self.horizons and not flat:
            for k in self.keys:
                s = scores.get(k, 0.0)
                if s != 0.0:
                    self.ic[k][h].add(s, norm)
            self.ic[ENS][h].add(it["ens"], norm)
            self.ic[FINAL][h].add(it["final"], norm)
        if h == self.meta_h and it["meta_x"] is not None and it["side"]:
            win = 1.0 if it["side"] * ret > it["cost"] else 0.0
            pm = self.meta.predict(it["meta_x"])
            self.cal_meta.add(pm, win)
            self.meta.update(it["meta_x"], win)
        if h != self.H or flat:
            return
        # primary horizon: the main learning step
        regime = it["regime"]
        rewards = {k: scores.get(k, 0.0) * norm / 3.0 for k in self.keys}
        self.hedge_global.update(rewards)
        if regime in self.hedge_regime:
            self.hedge_regime[regime].update(rewards)
        self.hedge_asset[coin].update(rewards)
        y = 1.0 if ret > 0 else 0.0
        self.cal_ml.add(it["p_up"], y)
        self.ml.update(it["x"], y)
        for k in self.keys + [ENS, FINAL]:
            s = it["ens"] if k == ENS else it["final"] if k == FINAL else scores.get(k, 0.0)
            if abs(s) <= 0.05:
                continue
            hit = (s > 0) == (ret > 0)
            c = self.counts[k]
            c[0] += 1
            c[1] += int(hit)
            self.shadow[k] += s * norm
            if k in self.arms:
                self.arms[k].update(hit)
            if regime in self.ic_regime[k]:
                self.ic_regime[k][regime].add(s, norm)
            if coin in self.ic_asset[k]:
                self.ic_asset[k][coin].add(s, norm)
        if abs(it["final"]) > 0.05:
            self.move.add(it["final"], norm)
        for name, val in zip(ML_FEATURES, it["x"].tolist()):
            if val != 0.0:
                self.feat_ic[name].add(val, norm)
        if abs(it["final"]) > 0.1:
            self.recent_final.append(1.0 if (it["final"] > 0) == (ret > 0) else 0.0)
        self.n_resolved += 1
        self._update_mutes()
        if self.n_resolved % 25 == 0:
            self._curve_point(t)

    def _update_mutes(self) -> None:
        for k in STRATEGY_KEYS:
            arm = self.arms[k]
            if arm.n >= 150 and arm.mean < 0.47 and arm.prob_above(0.5) < 0.05:
                self.muted.add(k)
            elif k in self.muted and (arm.mean >= 0.49 or arm.prob_above(0.5) > 0.2):
                self.muted.discard(k)

    def move_slope(self, coin: str | None = None) -> float | None:
        """Learned E[vol-normalised return over H | final score] per unit of score (regression through 0).
        A market's own slope is shrunk towards the pooled one with ``move_shrink`` pseudo-observations."""
        g = self.move
        if g.n < 300 or g.mss <= 1e-12:
            return None
        b = g.msr / g.mss
        a = self.ic_asset[FINAL].get(coin) if coin else None
        if a is not None and a.n >= 30 and a.mss > 1e-12:
            w, k = min(a.n, a.w), self.cfg.signal.move_shrink
            b = (w * a.msr / a.mss + k * b) / (w + k)
        return b

    def expected_move(self, coin: str, final: float, vol: float) -> float | None:
        """Expected log return over the learning horizon for this signal (signed, fraction of price)."""
        b = self.move_slope(coin)
        if b is None:
            return None
        return b * final * max(vol, 1e-6) * math.sqrt(self.H)

    def learn_trade(self, meta_x, win: bool) -> None:
        """Real closed trades teach the meta model with extra weight."""
        if meta_x is not None:
            self.meta.update(np.asarray(meta_x, dtype=float), 1.0 if win else 0.0, weight=3.0)

    def _curve_point(self, t: int) -> None:
        w = self.hedge_global.weights()
        top = sorted(w.items(), key=lambda kv: -kv[1])[:3]
        self.curve.append({
            "t": t, "n": self.n_resolved,
            "hit": float(np.mean(self.recent_final)) if self.recent_final else 0.5,
            "ic": self.ic[FINAL][self.H].corr, "ic_ens": self.ic[ENS][self.H].corr,
            "ml_brier": self.ml.brier(), "ml_acc": self.ml.accuracy(), "ml_n": self.ml.n,
            "meta_brier": self.meta.brier(), "meta_n": self.meta.n,
            "shadow": self.shadow[FINAL], "muted": len(self.muted),
            "w": {k: round(v, 4) for k, v in w.items()}, "top": [k for k, _ in top],
        })
        if len(self.curve) > 4000:
            half = len(self.curve) // 2
            self.curve = self.curve[:half:2] + self.curve[half:]

    # ── reporting ─────────────────────────────────────────────────────────
    def strategy_table(self) -> list[dict]:
        w = self.hedge_global.weights()
        rows = []
        for k in self.keys + [ENS, FINAL]:
            n, hits = self.counts[k]
            arm = self.arms.get(k)
            ic = self.ic[k][self.H]
            rows.append({
                "key": k, "weight": w.get(k), "n": n, "hit": hits / n if n else None,
                "ic": ic.corr, "t": ic.tstat, "shadow": self.shadow[k],
                "post_mean": arm.mean if arm else None, "p_edge": arm.prob_above(0.5) if arm else None,
                "ci": arm.ci() if arm else None, "muted": k in self.muted,
                "decay": {h: self.ic[k][h].corr for h in self.horizons},
            })
        return rows

    def snapshot(self, light: bool = False) -> dict:
        snap = {
            "n_resolved": self.n_resolved, "n_observed": self.n_observed, "horizon": self.H,
            "horizons": self.horizons, "meta_h": self.meta_h,
            "ml": {"n": self.ml.n, "brier": self.ml.brier(), "acc": self.ml.accuracy(), "logloss": self.ml.logloss(),
                   "ready": self.ml_ready},
            "meta": {"n": self.meta.n, "brier": self.meta.brier(), "acc": self.meta.accuracy(),
                     "ready": self.meta_ready},
            "hit_recent": float(np.mean(self.recent_final)) if self.recent_final else None,
            "ic_final": self.ic[FINAL][self.H].corr, "muted": sorted(self.muted),
            "move_slope": self.move_slope(), "move_n": self.move.n,
            "weights": self.hedge_global.weights(),
        }
        if light:
            return snap
        snap.update({
            "strategies": self.strategy_table(),
            "weights_regime": {r: h.weights() for r, h in self.hedge_regime.items() if h.n},
            "weights_asset": {c: h.weights() for c, h in self.hedge_asset.items() if h.n},
            "n_regime": {r: h.n for r, h in self.hedge_regime.items()},
            "ic_regime": {k: {r: v.corr for r, v in d.items() if v.n >= 10} for k, d in self.ic_regime.items()},
            "ic_asset": {k: {c: v.corr for c, v in d.items() if v.n >= 10} for k, d in self.ic_asset.items()},
            "feature_ic": sorted(({"feature": f, "ic": v.corr, "t": v.tstat, "n": v.n}
                                  for f, v in self.feat_ic.items()), key=lambda r: -abs(r["ic"])),
            "ml_importance": self.ml.importance()[:25],
            "meta_importance": self.meta.importance(),
            "cal_ml": self.cal_ml.table(), "cal_meta": self.cal_meta.table(),
            "curve": self.curve[-1500:],
        })
        return snap

    # ── persistence ───────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "version": self.VERSION, "keys": self.keys, "horizons": self.horizons,
            "hedge_global": self.hedge_global.to_dict(),
            "hedge_regime": {r: h.to_dict() for r, h in self.hedge_regime.items()},
            "hedge_asset": {c: h.to_dict() for c, h in self.hedge_asset.items()},
            "ml": self.ml.to_dict(), "meta": self.meta.to_dict(),
            "arms": {k: a.to_list() for k, a in self.arms.items()},
            "ic": {k: {str(h): v.to_list() for h, v in d.items()} for k, d in self.ic.items()},
            "ic_regime": {k: {r: v.to_list() for r, v in d.items()} for k, d in self.ic_regime.items()},
            "ic_asset": {k: {c: v.to_list() for c, v in d.items()} for k, d in self.ic_asset.items()},
            "feat_ic": {f: v.to_list() for f, v in self.feat_ic.items()},
            "move": self.move.to_list(),
            "shadow": self.shadow, "counts": self.counts,
            "cal_ml": self.cal_ml.to_dict(), "cal_meta": self.cal_meta.to_dict(),
            "curve": self.curve, "recent_final": list(self.recent_final),
            "n_resolved": self.n_resolved, "n_observed": self.n_observed,
            "trained_until": self.trained_until, "muted": sorted(self.muted),
        }

    def load(self, d: dict) -> None:
        if d.get("version") != self.VERSION:
            log.warning("Brain-Version %s passt nicht (%s) – starte frisch", d.get("version"), self.VERSION)
            return
        self.hedge_global.load(d.get("hedge_global", {}))
        for r, h in d.get("hedge_regime", {}).items():
            if r in self.hedge_regime:
                self.hedge_regime[r].load(h)
        for c, h in d.get("hedge_asset", {}).items():
            if c in self.hedge_asset:
                self.hedge_asset[c].load(h)
        self.ml.load(d.get("ml", {}))
        self.meta.load(d.get("meta", {}))
        for k, x in d.get("arms", {}).items():
            if k in self.arms:
                self.arms[k].load(x)
        for k, hd in d.get("ic", {}).items():
            for h, x in hd.items():
                if k in self.ic and int(h) in self.ic[k]:
                    self.ic[k][int(h)].load(x)
        for attr in ("ic_regime", "ic_asset"):
            tgt = getattr(self, attr)
            for k, dd in d.get(attr, {}).items():
                for sub, x in dd.items():
                    if k in tgt and sub in tgt[k]:
                        tgt[k][sub].load(x)
        for f, x in d.get("feat_ic", {}).items():
            if f in self.feat_ic:
                self.feat_ic[f].load(x)
        if d.get("move"):
            self.move.load(d["move"])
        for k, v in d.get("shadow", {}).items():
            if k in self.shadow:
                self.shadow[k] = float(v)
        for k, v in d.get("counts", {}).items():
            if k in self.counts:
                self.counts[k] = [int(v[0]), int(v[1])]
        self.cal_ml.load(d.get("cal_ml", {}))
        self.cal_meta.load(d.get("cal_meta", {}))
        self.curve = list(d.get("curve", []))
        self.recent_final.extend(d.get("recent_final", []))
        self.n_resolved = int(d.get("n_resolved", 0))
        self.n_observed = int(d.get("n_observed", 0))
        for c, t in d.get("trained_until", {}).items():
            if c in self.trained_until:
                self.trained_until[c] = int(t)
        self.muted = set(d.get("muted", [])) & set(STRATEGY_KEYS)

    def save(self, path: str | Path) -> None:
        p = Path(path)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), default=_json_default))
        tmp.replace(p)

    def load_file(self, path: str | Path) -> bool:
        p = Path(path)
        if not p.exists():
            return False
        try:
            self.load(json.loads(p.read_text()))
            log.info("Brain geladen: %d gelernte Beobachtungen, ML n=%d, Meta n=%d", self.n_resolved, self.ml.n,
                     self.meta.n)
            return True
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
            log.warning("Brain-Datei unlesbar (%s) – starte frisch", e)
            return False


def _json_default(o):
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(type(o))
