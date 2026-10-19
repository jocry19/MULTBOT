"""The learning brain.

Every bar, every strategy's opinion on every asset is recorded as a *pending evaluation*
(whether or not a trade is opened). When the forward horizon has elapsed the brain learns:

* Hedge weights (global, per regime, per asset) – which strategies to trust where
* Beta posteriors of each strategy's hit rate – strategies that are reliably wrong get muted
* an online logistic model that predicts the direction of the next move from ~40 features
* a meta-label model that predicts whether a trade candidate beats its costs
* the expected favourable move of a candidate by signal strength × volatility (all markets) – ranks entries
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
from .stats import BetaVec, Calibration, EWCorrVec, EWMean

log = logging.getLogger("multbot.brain")

META_FEATURES = ["abs_final", "agreement", "p_dir", "vol_pct", "spread", "stale", "session", "hurst_c", "adx_n",
                 "er_20", "funding_against", "side", "atr_bps", "trend", "range", "vol_high", "vol_low", "coverage"]

ENS = "ensemble"
FINAL = "final"
MOVE_F_EDGES = (0.2, 0.28, 0.35, 0.42, 0.5, 0.6)   # |final score| buckets of the expected-move table
MOVE_S_EDGES = (0.003, 0.0065, 0.011)              # horizon volatility σ·√H buckets (fraction of price)


class Brain:
    VERSION = 5   # 5: vectorised learner state (numpy), lead-lag off, 1 h horizon

    def __init__(self, cfg: Config, coins: list[str]):
        self.cfg = cfg
        lc, sc = cfg.learning, cfg.signal
        self.coins = list(coins)
        self.keys = list(ALL_KEYS)                         # strategies + ML (Hedge / ensemble members)
        self.track = self.keys + [ENS, FINAL]              # everything with statistics
        self.kidx = {k: i for i, k in enumerate(self.track)}
        nk, nt = len(self.keys), len(self.track)
        self.i_ml, self.i_ens, self.i_final = self.kidx[ML_KEY], self.kidx[ENS], self.kidx[FINAL]
        self.rule_mask = np.array([k in STRATEGY_KEYS for k in self.keys])
        self.horizons = sorted(set(int(h) for h in sc.decay_horizons) | {int(sc.horizon)})
        self.H = int(sc.horizon)
        self.meta_h = min(max(self.horizons), self.H * 4)
        self._resolve_at = set(self.horizons) | {self.meta_h}
        self._max_age = max(max(self.horizons), self.meta_h)
        self.hedge_global = Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay)
        self.hedge_regime = {r: Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay) for r in REGIMES}
        self.hedge_asset = {c: Hedge(self.keys, lc.hedge_eta, lc.hedge_floor, lc.hedge_decay) for c in self.coins}
        self.ml = OnlineLogit(ML_FEATURES, lc.lr, lc.l2)
        self.meta = OnlineLogit(META_FEATURES, lc.lr, lc.l2)
        self.arms = BetaVec(nt)
        self.ic = {h: EWCorrVec(nt) for h in self.horizons}           # signal decay per horizon
        self.ic_regime = {r: EWCorrVec(nt) for r in REGIMES}
        self.ic_asset = {c: EWCorrVec(nt) for c in self.coins}
        self.feat_ic = EWCorrVec(len(ML_FEATURES))
        # realised move in signal direction over H for every candidate, pooled and per |score| × σ bucket
        self.move = EWMean(halflife=20000)
        self.move_cells = [[EWMean(halflife=20000) for _ in range(len(MOVE_S_EDGES) + 1)]
                           for _ in range(len(MOVE_F_EDGES) + 1)]
        self.shadow = np.zeros(nt)
        self.cnt_n = np.zeros(nt, dtype=np.int64)
        self.cnt_hit = np.zeros(nt, dtype=np.int64)
        self.cal_ml = Calibration()
        self.cal_meta = Calibration()
        self.pending: dict[str, deque] = {c: deque() for c in self.coins}
        self.curve: list[dict] = []
        self.recent_final = deque(maxlen=300)
        self.n_resolved = 0
        self.n_observed = 0
        self.trained_until: dict[str, int] = {c: 0 for c in self.coins}
        self.muted: set[str] = set()
        self._off = np.zeros(nk, dtype=bool)
        self._refresh_off()
        self.last_t = 0

    # ── decision ──────────────────────────────────────────────────────────
    def _refresh_off(self) -> None:
        off = self.muted | set(self.cfg.signal.disabled_strategies)
        self._off = np.array([k in off for k in self.keys])

    def weight_vec(self, coin: str, regime: str) -> np.ndarray:
        layers = [(self.hedge_global.logw, 1.0)]
        hr = self.hedge_regime.get(regime)
        if hr and hr.n:
            layers.append((hr.logw, min(1.0, hr.n / 300)))
        ha = self.hedge_asset.get(coin)
        if ha and ha.n:
            layers.append((ha.logw, min(1.0, ha.n / 300)))
        w = softmax_floor(blend_logw(layers), self.cfg.learning.hedge_floor)
        w[self._off] = 0.0
        s = w.sum()
        return w / s if s > 0 else w

    def weights(self, coin: str, regime: str) -> dict[str, float]:
        return dict(zip(self.keys, self.weight_vec(coin, regime).tolist()))

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
        sv = np.array([all_scores.get(k, 0.0) for k in self.keys])
        w = self.weight_vec(coin, regime)
        rules = self.rule_mask & ~self._off
        tot = float(w[rules].sum()) or 1.0
        big = np.abs(sv) > 0.05
        act = rules & big
        wa = float(w[act].sum())
        raw = float(w[act] @ sv[act]) / wa if wa > 0 else 0.0
        coverage = wa / tot
        ens = raw * math.sqrt(coverage)
        blend = self.cfg.signal.ml_blend if self.ml_ready else 0.0
        final = (1 - blend) * ens + blend * ml_score
        mass_v = w * np.abs(sv)
        mass = float(mass_v.sum()) or 1.0
        agree = float(mass_v[big & (sv * final > 0)].sum()) / mass if final else 0.0
        idx = np.nonzero(big)[0]
        c = w[idx] * sv[idx] / tot
        order = np.argsort(-np.abs(c))[:8]
        contrib = [(self.keys[idx[o]], float(c[o])) for o in order]
        s_track = np.empty(len(self.track))
        s_track[:len(self.keys)] = sv
        s_track[self.i_ens], s_track[self.i_final] = ens, final
        return {"scores": all_scores, "s": s_track, "ens": ens, "final": final, "p_up": p_up,
                "ml_score": ml_score, "agreement": agree, "coverage": coverage, "contrib": contrib, "x": x}

    def meta_vector(self, d: dict, frow: dict[str, float], side: int, regime_label: str) -> np.ndarray:
        trend, vol = regime_label.split("-")
        p_dir = d["p_up"] if side > 0 else 1 - d["p_up"]
        x = np.array([
            abs(d["final"]), d["agreement"], p_dir, frow.get("vol_pct", 0.5), frow.get("spread_bps", 0.0) / 10,
            frow.get("stale", 0.0), frow.get("session", 1.0), frow.get("hurst_c", 0.0), frow.get("adx_n", 0.0),
            frow.get("er_20", 0.0), side * frow.get("funding_h", 0.0) * 1e4, float(side),
            frow.get("atr_pct", 0.0) * 1e4, float(trend == "TREND"), float(trend == "RANGE"),
            float(vol == "HIGH"), float(vol == "LOW"), d["coverage"],
        ], dtype=float)
        if not np.isfinite(x).all():
            np.nan_to_num(x, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        return x

    def p_win(self, meta_x: np.ndarray) -> float | None:
        return self.meta.predict(meta_x) if self.meta_ready else None

    # ── observation / resolution ─────────────────────────────────────────
    def observe(self, coin: str, t: int, px: float, vol: float, regime: str, d: dict, frow: dict[str, float],
                meta_x: np.ndarray | None, side: int, cost: float, pretrain: bool = False) -> None:
        self.pending[coin].append({
            "t": t, "px": px, "vol": max(vol, 1e-6), "regime": regime, "s": d["s"], "final": d["final"],
            "p_up": d["p_up"], "x": d["x"], "meta_x": meta_x, "side": side, "cost": cost, "age": 0,
            "pre": pretrain,
        })
        self.n_observed += 1
        self.last_t = max(self.last_t, t)

    def on_bar(self, coin: str, close: float, t: int) -> int:
        """Advance the age of pending evaluations for ``coin`` and learn from those that matured."""
        q = self.pending.get(coin)
        if not q:
            return 0
        learned = 0
        lc = math.log(max(close, 1e-300))
        at = self._resolve_at
        for item in q:
            item["age"] += 1
            age = item["age"]
            if age in at:
                self._resolve(coin, item, age, lc - math.log(max(item["px"], 1e-300)), t)
                if age == self.H:
                    learned += 1
        while q and q[0]["age"] >= self._max_age:
            q.popleft()
        if t > self.trained_until.get(coin, 0):
            self.trained_until[coin] = t
        return learned

    def _resolve(self, coin: str, it: dict, h: int, ret: float, t: int) -> None:
        flat = abs(ret) < 1e-9
        norm = max(-3.0, min(3.0, ret / (it["vol"] * math.sqrt(h))))
        s = it["s"]
        if h in self.ic and not flat:
            idx = np.nonzero(s)[0]
            self.ic[h].add(idx, s[idx], norm)
        if h == self.meta_h and it["meta_x"] is not None and it["side"]:
            win = 1.0 if it["side"] * ret > it["cost"] else 0.0
            pm = self.meta.predict(it["meta_x"])
            self.cal_meta.add(pm, win)
            self.meta.update(it["meta_x"], win)
        if h == self.H and it["side"] and not it.get("pre"):
            # Live history pre-training runs market by market, so a later market's signals already benefit from
            # what the brain learned on other markets over the same period – fine for warm-starting weights, but
            # it would overstate how far signals move. The move table therefore learns only from clean data.
            cap = 4.0 * it["vol"] * math.sqrt(h)                  # winsorise pumps / dumps of thin markets
            fav = it["side"] * max(-cap, min(cap, ret))           # flat bars count too: a trade only pays costs
            self.move.add(fav)
            self._move_cell(it["final"], it["vol"]).add(fav)
        if h != self.H or flat:
            return
        # primary horizon: the main learning step
        regime = it["regime"]
        nk = len(self.keys)
        rewards = s[:nk] * (norm / 3.0)
        self.hedge_global.update(rewards)
        if regime in self.hedge_regime:
            self.hedge_regime[regime].update(rewards)
        self.hedge_asset[coin].update(rewards)
        y = 1.0 if ret > 0 else 0.0
        self.cal_ml.add(it["p_up"], y)
        self.ml.update(it["x"], y)
        idx = np.nonzero(np.abs(s) > 0.05)[0]
        if len(idx):
            sv = s[idx]
            hit = ((sv > 0) == (ret > 0)).astype(float)
            self.cnt_n[idx] += 1
            self.cnt_hit[idx] += hit.astype(np.int64)
            self.shadow[idx] += sv * norm
            self.arms.update(idx, hit)
            if regime in self.ic_regime:
                self.ic_regime[regime].add(idx, sv, norm)
            if coin in self.ic_asset:
                self.ic_asset[coin].add(idx, sv, norm)
        xi = np.nonzero(it["x"])[0]
        self.feat_ic.add(xi, it["x"][xi], norm)
        if abs(it["final"]) > 0.1:
            self.recent_final.append(1.0 if (it["final"] > 0) == (ret > 0) else 0.0)
        self.n_resolved += 1
        if self.n_resolved % 10 == 0:
            self._update_mutes()
        if self.n_resolved % 25 == 0:
            self._curve_point(t)

    def _update_mutes(self) -> None:
        mean, n = self.arms.mean, self.arms.n
        before = set(self.muted)
        for k in STRATEGY_KEYS:
            i = self.kidx[k]
            if k not in self.muted:
                if n[i] >= 150 and mean[i] < 0.47 and self.arms.prob_above(i) < 0.05:
                    self.muted.add(k)
            elif mean[i] >= 0.49 or self.arms.prob_above(i) > 0.2:
                self.muted.discard(k)
        if self.muted != before:
            self._refresh_off()

    def _move_cell(self, final: float, vol: float) -> EWMean:
        sig_h = max(vol, 0.0) * math.sqrt(self.H)
        fi = sum(abs(final) >= e for e in MOVE_F_EDGES)
        si = sum(sig_h >= e for e in MOVE_S_EDGES)
        return self.move_cells[fi][si]

    def _pooled_move(self) -> float:
        sc, g = self.cfg.signal, self.move
        return (g.w * g.m + sc.move_prior_n * sc.move_prior_bps / 1e4) / (g.w + sc.move_prior_n)

    def expected_move(self, final: float, vol: float) -> float:
        """Expected move in the signal's direction over the learning horizon (fraction of price), learned from
        what candidates with this signal strength and volatility actually did. A non-parametric table on
        purpose: in walk-forward tests the edge did not grow with the score – the strongest signals and the
        most volatile markets did worst – so a linear "score × volatility" model ranks them the wrong way.
        Each cell is shrunk towards the pooled mean with ``move_shrink`` pseudo-observations, the pooled mean
        towards a cautious prior (``move_prior_bps``) until enough has been observed."""
        c = self._move_cell(final, vol)
        k = self.cfg.signal.move_shrink
        return (c.w * c.m + k * self._pooled_move()) / (c.w + k)

    def learn_trade(self, meta_x, win: bool) -> None:
        """Real closed trades teach the meta model with extra weight."""
        if meta_x is not None:
            self.meta.update(np.asarray(meta_x, dtype=float), 1.0 if win else 0.0, weight=3.0)

    def ic_value(self, kind: str, sub: str, key: str = FINAL) -> tuple[float, int]:
        """(correlation, observations) of ``key`` per regime (kind="regime") or market (kind="asset")."""
        v = (self.ic_regime if kind == "regime" else self.ic_asset).get(sub)
        if v is None:
            return 0.0, 0
        i = self.kidx[key]
        return float(v.corr()[i]), int(v.n[i])

    def _curve_point(self, t: int) -> None:
        w = self.hedge_global.weights()
        top = sorted(w.items(), key=lambda kv: -kv[1])[:3]
        icH = self.ic[self.H].corr()
        self.curve.append({
            "t": t, "n": self.n_resolved,
            "hit": float(np.mean(self.recent_final)) if self.recent_final else 0.5,
            "ic": float(icH[self.i_final]), "ic_ens": float(icH[self.i_ens]),
            "ml_brier": self.ml.brier(), "ml_acc": self.ml.accuracy(), "ml_n": self.ml.n,
            "meta_brier": self.meta.brier(), "meta_n": self.meta.n,
            "shadow": float(self.shadow[self.i_final]), "muted": len(self.muted),
            "w": {k: round(v, 4) for k, v in w.items()}, "top": [k for k, _ in top],
        })
        if len(self.curve) > 4000:
            half = len(self.curve) // 2
            self.curve = self.curve[:half:2] + self.curve[half:]

    # ── reporting ─────────────────────────────────────────────────────────
    def strategy_table(self) -> list[dict]:
        w = self.hedge_global.weights()
        icH, tH = self.ic[self.H].corr(), self.ic[self.H].tstat()
        decay = {h: self.ic[h].corr() for h in self.horizons}
        mean = self.arms.mean
        rows = []
        for i, k in enumerate(self.track):
            n, hits = int(self.cnt_n[i]), int(self.cnt_hit[i])
            arm = k != ENS
            rows.append({
                "key": k, "weight": w.get(k), "n": n, "hit": hits / n if n else None,
                "ic": float(icH[i]), "t": float(tH[i]), "shadow": float(self.shadow[i]),
                "post_mean": float(mean[i]) if arm else None, "p_edge": self.arms.prob_above(i) if arm else None,
                "ci": self.arms.ci(i) if arm else None, "muted": k in self.muted,
                "decay": {h: float(decay[h][i]) for h in self.horizons},
            })
        return rows

    def _ic_table(self, by: dict[str, EWCorrVec], subs: list[str] | None = None) -> dict:
        cols = {sub: (v.corr(), v.n) for sub, v in by.items() if subs is None or sub in subs}
        return {k: {sub: float(c[i]) for sub, (c, n) in cols.items() if n[i] >= 10} for i, k in enumerate(self.track)}

    def snapshot(self, light: bool = False, asset_limit: int | None = None) -> dict:
        snap = {
            "n_resolved": self.n_resolved, "n_observed": self.n_observed, "horizon": self.H,
            "horizons": self.horizons, "meta_h": self.meta_h,
            "ml": {"n": self.ml.n, "brier": self.ml.brier(), "acc": self.ml.accuracy(), "logloss": self.ml.logloss(),
                   "ready": self.ml_ready},
            "meta": {"n": self.meta.n, "brier": self.meta.brier(), "acc": self.meta.accuracy(),
                     "ready": self.meta_ready},
            "hit_recent": float(np.mean(self.recent_final)) if self.recent_final else None,
            "ic_final": float(self.ic[self.H].corr()[self.i_final]), "muted": sorted(self.muted),
            "move_mean": self._pooled_move(), "move_n": self.move.n,
            "weights": self.hedge_global.weights(),
        }
        if light:
            return snap
        subs = None
        if asset_limit:
            nf = {c: int(v.n[self.i_final]) for c, v in self.ic_asset.items()}
            subs = sorted(nf, key=lambda c: -nf[c])[:asset_limit]
        fic, ft = self.feat_ic.corr(), self.feat_ic.tstat()
        snap.update({
            "strategies": self.strategy_table(),
            "weights_regime": {r: h.weights() for r, h in self.hedge_regime.items() if h.n},
            "n_regime": {r: h.n for r, h in self.hedge_regime.items()},
            "ic_regime": self._ic_table(self.ic_regime),
            "ic_asset": self._ic_table(self.ic_asset, subs),
            "feature_ic": sorted(({"feature": f, "ic": float(fic[i]), "t": float(ft[i]), "n": int(self.feat_ic.n[i])}
                                  for i, f in enumerate(ML_FEATURES)), key=lambda r: -abs(r["ic"])),
            "ml_importance": self.ml.importance()[:25],
            "meta_importance": self.meta.importance(),
            "cal_ml": self.cal_ml.table(), "cal_meta": self.cal_meta.table(),
            "curve": self.curve[-1500:],
            "move_table": {"f_edges": MOVE_F_EDGES, "s_edges": MOVE_S_EDGES,
                           "cells": [[{"m": c.m, "n": c.n} for c in row] for row in self.move_cells]},
        })
        return snap

    # ── persistence ───────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "version": self.VERSION, "track": self.track, "horizons": self.horizons, "features": ML_FEATURES,
            "hedge_global": self.hedge_global.to_dict(),
            "hedge_regime": {r: h.to_dict() for r, h in self.hedge_regime.items()},
            "hedge_asset": {c: h.to_dict() for c, h in self.hedge_asset.items() if h.n},
            "ml": self.ml.to_dict(), "meta": self.meta.to_dict(), "arms": self.arms.to_list(),
            "ic": {str(h): v.to_list() for h, v in self.ic.items()},
            "ic_regime": {r: v.to_list() for r, v in self.ic_regime.items()},
            "ic_asset": {c: v.to_list() for c, v in self.ic_asset.items() if v.n.any()},
            "feat_ic": self.feat_ic.to_list(),
            "move": self.move.to_list(), "move_cells": [[c.to_list() for c in row] for row in self.move_cells],
            "shadow": self.shadow.tolist(), "cnt_n": self.cnt_n.tolist(), "cnt_hit": self.cnt_hit.tolist(),
            "cal_ml": self.cal_ml.to_dict(), "cal_meta": self.cal_meta.to_dict(),
            "curve": self.curve, "recent_final": list(self.recent_final),
            "n_resolved": self.n_resolved, "n_observed": self.n_observed,
            "trained_until": self.trained_until, "muted": sorted(self.muted),
        }

    def load(self, d: dict) -> None:
        if d.get("version") != self.VERSION:
            log.warning("Brain-Version %s passt nicht (%s) – starte frisch", d.get("version"), self.VERSION)
            return
        same_keys = d.get("track") == self.track
        self.hedge_global.load(d.get("hedge_global", {}))
        for r, h in d.get("hedge_regime", {}).items():
            if r in self.hedge_regime:
                self.hedge_regime[r].load(h)
        for c, h in d.get("hedge_asset", {}).items():
            if c in self.hedge_asset:
                self.hedge_asset[c].load(h)
        self.ml.load(d.get("ml", {}))
        self.meta.load(d.get("meta", {}))
        if same_keys:   # statistics are positional: only reuse them for the same strategy set
            self.arms.load(d.get("arms", []))
            for h, x in d.get("ic", {}).items():
                if int(h) in self.ic:
                    self.ic[int(h)].load(x)
            for attr in ("ic_regime", "ic_asset"):
                tgt = getattr(self, attr)
                for sub, x in d.get(attr, {}).items():
                    if sub in tgt:
                        tgt[sub].load(x)
            if len(d.get("shadow", [])) == len(self.track):
                self.shadow = np.array(d["shadow"], dtype=float)
                self.cnt_n = np.array(d.get("cnt_n", [0] * len(self.track)), dtype=np.int64)
                self.cnt_hit = np.array(d.get("cnt_hit", [0] * len(self.track)), dtype=np.int64)
        if d.get("features") == ML_FEATURES:
            self.feat_ic.load(d.get("feat_ic", []))
        if d.get("move") and len(d["move"]) == 3:
            self.move.load(d["move"])
            cells = d.get("move_cells") or []
            if len(cells) == len(self.move_cells) and all(len(r) == len(MOVE_S_EDGES) + 1 for r in cells):
                for row, xs in zip(self.move_cells, cells):
                    for c, x in zip(row, xs):
                        c.load(x)
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
        self._refresh_off()

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
