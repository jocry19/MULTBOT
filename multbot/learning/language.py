"""Lebende Marktsprache – every statistic becomes language; vocabulary and meaning emerge while listening.

Nothing here is a fixed strategy or a fixed alphabet. The bot listens to the markets the way a child learns to
speak: it hears sounds, groups them into words, learns what the words mean from what happens next, and only
speaks (trades) once its own statements have turned out to be true often enough.

**Sounds (Laute).** Every statistic of the feature pipeline – price, momentum, position in the range, volatility,
volume, order flow, order book, funding, premium, open interest, the leader market, the time of day – plus the
mood of all markets in the last completed bar is measured relative to *that market's own recent behaviour*
(an exponentially forgetting mean and variance per market and statistic). A statistic is "loud" when it is
unusual for this market right now – not when it crosses a fixed threshold.

**Words (Wörter).** The statistics are heard through eight senses: movement, location, energy, character, flow,
positioning, surroundings, time. In each sense the bot forms its own vocabulary by online vector quantisation:
a sound unlike every known word gives birth to a new word, words nobody uses any more are forgotten and their
place is reused, and every word slowly shifts with what it hears (frequency-sensitive competitive learning –
common sounds get finer distinctions). No word list is given in advance; a word's name is generated from what it
currently sounds like ("Bar/σ⇈ Volumen↑").

**Meaning (Bedeutung).** What a market says in one bar is a sentence: one word per sense, how each word changed
since the last bar (transitions), each word together with the movement word, the market's own dialect and that
of its asset class. Every phrase gets a learned meaning – its contribution to the move over the horizon in units
of volatility – fitted online on the joint residual, with pseudo-counts so that a phrase needs evidence before it
means anything. Three memories forget at different speeds (half-life 1, 5 and 25 days by default); they are
weighted by how well each has predicted lately – the bot learns how fast the market's language changes.

**Listening in context.** A single sentence is noisy: the decision uses what the market has been saying lately
(exponentially smoothed, half-life ≈ a third of the horizon).

**Speaking = trading, only if it came true.** Every statement is checked against what really happened. For each
conviction level (how loud the statement is relative to everything the bot says) and direction it keeps the
realised move – one observation per bar across all markets, so markets moving together do not count as
independent evidence – and believes it only with Bayesian scepticism (prior: edges are small). The bot trades
only when this believed move beats the costs (``proof_sd`` > 0 demands a margin of proof on top). If its language
stops coming true, it falls silent by itself.
"""
from __future__ import annotations

import base64
import math
import zlib
from collections import deque
from operator import itemgetter

import numpy as np

from ..features.pipeline import FEATURES

# ── senses: every statistic of the pipeline belongs to exactly one ─────────
CHANNELS: list[tuple[str, str, list[str]]] = [
    ("B", "Bewegung", ["ret_1", "ret_z", "ret_3", "ret_12", "ret_48", "tsmom", "kf_slope_z", "ema_spread",
                       "ema_slope", "macd_hist_z", "dmi"]),
    ("L", "Lage", ["close", "bb_z", "rsi_14", "rsi_7", "stoch_k", "stoch_d", "don_pos", "don_break", "range_pos",
                   "vwap_dev", "kf_dev", "ema200_dev", "ema_align"]),
    ("E", "Energie", ["vol", "vol_pct", "atr", "atr_pct", "rng_z", "bb_width", "bb_width_rank", "squeeze",
                      "squeeze_prev", "park_vol", "gk_vol"]),
    ("C", "Charakter", ["er_20", "vr_4", "hurst", "ac_1", "skew", "adx", "stale"]),
    ("F", "Fluss", ["vol_z", "obv_flow", "flow_imb", "trade_rate", "book_imb5", "book_imb20", "microprice_bps",
                    "spread_bps", "depth_usd"]),
    ("P", "Positionierung", ["funding_h", "funding_z", "premium_bps", "oi_chg", "oracle_age_min"]),
    ("U", "Umfeld", ["lead_ret_1", "lead_ret_3", "lead_beta", "lag_gap", "m_breadth", "m_ret", "m_disp", "m_act",
                     "m_volume", "m_funding", "m_course"]),
    ("Z", "Zeit", ["session", "hour_sin", "hour_cos"]),
]
DUPLICATES = {"funding_ann": "= funding_h × 8760"}   # exact copies would only count the same sound twice
MOOD_KEYS = ["m_breadth", "m_ret", "m_disp", "m_act", "m_volume", "m_funding", "m_course"]
MOOD_TEXT = {"m_breadth": "Anteil steigender Märkte", "m_ret": "mittlere Bar-Rendite / σ",
             "m_disp": "Streuung der Bar-Renditen / σ", "m_act": "mittlere |Bar-Rendite| / σ",
             "m_volume": "mittlerer Volumen-z-Score", "m_funding": "mittlerer Funding-z-Score",
             "m_course": "mittlere Stunden-Rendite / σ"}
SHORT = {
    "ret_1": "Kurs1", "ret_z": "Bar/σ", "ret_3": "Kurs3", "ret_12": "Kurs12", "ret_48": "Kurs48",
    "tsmom": "Momentum", "kf_slope_z": "Drift", "ema_spread": "EMA-Abstand", "ema_slope": "EMA-Steigung",
    "macd_hist_z": "MACD", "dmi": "DMI", "close": "Kurs", "bb_z": "Bollinger", "rsi_14": "RSI14", "rsi_7": "RSI7",
    "stoch_k": "Stoch", "stoch_d": "StochD", "don_pos": "Kanal", "don_break": "Ausbruch", "range_pos": "Range",
    "vwap_dev": "VWAP", "kf_dev": "Kalman", "ema200_dev": "EMA200", "ema_align": "Trendordnung", "vol": "Vola",
    "vol_pct": "Vola-Rang", "atr": "ATR", "atr_pct": "ATR%", "rng_z": "Spanne", "bb_width": "BB-Breite",
    "bb_width_rank": "BB-Rang", "squeeze": "Squeeze", "squeeze_prev": "Squeeze-kürzlich", "park_vol": "Parkinson",
    "gk_vol": "Garman-Klass", "er_20": "Effizienz", "vr_4": "Var-Ratio", "hurst": "Hurst", "ac_1": "Autokorr",
    "skew": "Schiefe", "adx": "ADX", "stale": "Stillstand", "vol_z": "Volumen", "obv_flow": "OBV",
    "flow_imb": "Aggressoren", "trade_rate": "Trade-Rate", "book_imb5": "Buch5", "book_imb20": "Buch20",
    "microprice_bps": "Microprice", "spread_bps": "Spread", "depth_usd": "Tiefe", "funding_h": "Funding",
    "funding_z": "Funding-z", "premium_bps": "Prämie", "oi_chg": "OI", "oracle_age_min": "Oracle-Alter",
    "lead_ret_1": "Leitmarkt", "lead_ret_3": "Leitmarkt3", "lead_beta": "Beta", "lag_gap": "Nachhol-Lücke",
    "m_breadth": "Marktbreite", "m_ret": "Markt", "m_disp": "Streuung", "m_act": "Hektik", "m_volume": "Marktvolumen",
    "m_funding": "Markt-Funding", "m_course": "Markt-Stunde", "session": "Session", "hour_sin": "Uhr☀",
    "hour_cos": "Uhr☾",
}
MEMORY_NAMES = ("kurz", "mittel", "lang")

TABLE = 1 << 17                 # hashed phrase table
_M64 = (1 << 64) - 1
PRIOR_COUNT = 100.0             # pseudo-observations before a phrase means anything (shrinks rare phrases to 0)
NORM_DAYS = 2.0                 # "recent behaviour" of a statistic: half-life of the per-market mean / variance
NORM_WARMUP = 12                # bars per market before its statistics make sounds
CONVICTION_EDGES = (0.5, 1.0, 1.5, 2.0, 3.0)   # |statement| in units of the RMS of everything said
TRUST_HALFLIFE_BARS = 2000.0    # memory of the "did it come true" check (in bars)
TRUST_VAR_PRIOR = (1.0, 10.0)   # prior variance of a bar's outcome and its weight in bars (no early certainty)
MIX_HALFLIFE = 3000.0           # memory of each memory's prediction record (in resolutions)
MIX_ETA = 0.1


def _h(*xs: int) -> int:
    """Stable hash into the phrase table (Python's hash() of str is salted per process)."""
    h = 1469598103934665603
    for x in xs:
        h = ((h ^ (x & _M64)) * 1099511628211) & _M64
    h ^= h >> 29
    h = (h * 0xBF58476D1CE4E5B9) & _M64
    h ^= h >> 32
    return h & (TABLE - 1)


def _sid(s: str) -> int:
    return zlib.crc32(s.encode())


def _arrow(z: float) -> str:
    return "⇈" if z >= 1.5 else "↑" if z >= 0.5 else "⇊" if z <= -1.5 else "↓" if z <= -0.5 else "·"


def _pack(a: np.ndarray) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(a, dtype=np.float32).tobytes(), 6)).decode()


def _unpack(s: str, shape) -> np.ndarray:
    return np.frombuffer(zlib.decompress(base64.b64decode(s)), dtype=np.float32).astype(float).reshape(shape)


def covered_statistics() -> set[str]:
    return {s for _, _, st in CHANNELS for s in st}


def unheard_features() -> set[str]:
    """Pipeline statistics the language does not hear (must be empty apart from exact duplicates)."""
    return set(FEATURES) - covered_statistics() - set(DUPLICATES)


class _Vocab:
    """The vocabularies of all senses (online vector quantisation, vectorised over senses).

    Per sense: a growing set of words (prototypes in z units). A sound unlike every known word gives birth to
    a new word; a word nobody uses any more is forgotten and its place reused; each word moves towards what it
    hears. Popular words must be closer to win (frequency-sensitive), so common sounds get finer distinctions.
    """

    def __init__(self, senses: list[tuple[str, str, list[str], list[int]]], max_words: int, D: int):
        self.keys = [k for k, _, _, _ in senses]
        self.names = [n for _, n, _, _ in senses]
        self.stats = [st for _, _, st, _ in senses]
        G = self.G = len(senses)
        self.dg = np.array([len(st) for st in self.stats], dtype=float)
        Dm = int(self.dg.max())
        self.kmax = np.array([int(min(max_words, max(12, 4 * len(st)))) for st in self.stats])
        K = self.K = int(self.kmax.max())
        self.pidx = np.full((G, Dm), D)                 # D = index of a constant 0 (padding)
        for g, (_, _, _, ix) in enumerate(senses):
            self.pidx[g, : len(ix)] = ix
        self.P = np.zeros((G, K, Dm))
        self.use = np.zeros((G, K))
        self.n = np.zeros((G, K))
        self.uid = np.full((G, K), -1, dtype=np.int64)
        self.born = np.zeros((G, K))
        self.k = np.zeros(G, dtype=np.int64)
        self.next_uid = np.zeros(G, dtype=np.int64)
        self.dm = np.zeros(G)
        self.dv = np.zeros(G)
        self.dn = np.zeros(G)
        self.births = np.zeros(G, dtype=np.int64)
        self.deaths = np.zeros(G, dtype=np.int64)
        self.lam_use = (0.5 ** (1.0 / (self.kmax * 400.0)))[:, None]
        self.d_win = 1.0 / (1.0 - 0.5 ** (1.0 / 2000.0))       # memory of the typical distance to a word
        self.a_min = 1.0 / self.d_win
        self.inv_dg = (1.0 / self.dg)[:, None]
        self.slots = np.arange(K)
        self.rows = np.arange(G)
        self._refresh()

    def _new(self, g: int, slot: int, x: np.ndarray, t: int) -> None:
        k = self.k[g]
        self.P[g, slot] = x
        self.use[g, slot] = self.use[g, :k].mean() if k else 1.0
        self.n[g, slot] = 1
        self.uid[g, slot] = self.next_uid[g]
        self.born[g, slot] = t
        self.next_uid[g] += 1
        self.births[g] += 1

    def hear(self, z_ext: np.ndarray, t: int, learn: bool) -> np.ndarray:
        """Slot of the word each sense hears (−1 while a sense knows no word yet)."""
        x = z_ext[self.pidx]                                         # (G, Dm), padding = 0
        diff = self.P - x[:, None, :]
        d2 = np.einsum("gkd,gkd->gk", diff, diff) * self.inv_dg + self.pen
        near = d2.min(1)
        share = self.use / np.maximum(self.use.sum(1, keepdims=True), 1e-12)
        j = np.argmin(d2 * np.sqrt(np.maximum(share * self.kf, 1e-3)), axis=1)
        empty = self.k == 0
        if not learn:
            return np.where(empty, -1, j)
        sd = np.sqrt(np.maximum(self.dv, 1e-12))
        novel = (self.dn > 200) & (near > self.dm + 3.0 * sd)
        if empty.any():
            near = np.where(empty, self.dm, near)
        a = self.a_min if self.dn[0] > 2 * self.d_win else 1.0 / np.minimum(self.dn + 1.0, self.d_win)
        dd = near - self.dm
        self.dm += a * dd
        self.dv = (1 - a) * (self.dv + a * dd * dd)
        self.dn += 1
        for g in np.nonzero(novel | empty)[0]:
            k = int(self.k[g])
            if k < self.kmax[g]:                                    # a new sound → a new word
                self._new(g, k, x[g], t)
                self.k[g] += 1
                j[g] = k
            else:
                weakest = int(np.argmin(share[g, :k]))
                if share[g, weakest] < 0.1 / k:                     # nobody uses it any more → forgotten
                    self._new(g, weakest, x[g], t)
                    self.deaths[g] += 1
                    j[g] = weakest
            self._refresh()
        self.use *= self.lam_use
        r = self.rows
        self.use[r, j] += 1.0
        n = self.n[r, j] + 1.0
        self.n[r, j] = n
        self.P[r, j] += np.maximum(1.0 / n, 0.004)[:, None] * (x - self.P[r, j])
        return j

    def _refresh(self) -> None:
        self.pen = np.where(self.slots[None, :] < self.k[:, None], 0.0, np.inf)
        self.kf = self.k[:, None].astype(float)

    def label(self, g: int, slot: int) -> str:
        if slot < 0:
            return "-"
        d = int(self.dg[g])
        p = self.P[g, slot, :d]
        st = self.stats[g]
        order = np.argsort(-np.abs(p))[:2]
        parts = [f"{SHORT.get(st[i], st[i])}{_arrow(p[i])}" for i in order if abs(p[i]) >= 0.5]
        return " ".join(parts) or "normal"

    def code(self, g: int, slot: int) -> str:
        return f"{self.keys[g]}{int(self.uid[g, slot])}" if slot >= 0 else "-"

    def to_dict(self) -> dict:
        out = []
        for g in range(self.G):
            k, d = int(self.k[g]), int(self.dg[g])
            out.append({"P": self.P[g, :k, :d].round(5).tolist(), "use": self.use[g, :k].tolist(),
                        "n": self.n[g, :k].tolist(), "uid": self.uid[g, :k].tolist(), "born": self.born[g, :k].tolist(),
                        "next_uid": int(self.next_uid[g]), "dm": float(self.dm[g]), "dv": float(self.dv[g]),
                        "dn": float(self.dn[g]), "births": int(self.births[g]), "deaths": int(self.deaths[g])})
        return {"senses": out}

    def load(self, data: dict) -> None:
        for g, d in enumerate(data.get("senses", [])[: self.G]):
            P = np.asarray(d.get("P", []), dtype=float)
            if P.ndim != 2 or P.shape[1] != int(self.dg[g]) or len(P) > self.kmax[g]:
                continue
            k = len(P)
            self.k[g] = k
            self.P[g, :k, : P.shape[1]] = P
            self.use[g, :k] = d["use"]
            self.n[g, :k] = d["n"]
            self.uid[g, :k] = d["uid"]
            self.born[g, :k] = d["born"]
            self.next_uid[g] = int(d["next_uid"])
            self.dm[g], self.dv[g], self.dn[g] = float(d["dm"]), float(d["dv"]), float(d["dn"])
            self.births[g], self.deaths[g] = int(d["births"]), int(d["deaths"])
        self._refresh()


class MarketLanguage:
    VERSION = 3

    def __init__(self, horizon: int, bars_per_hour: float = 12.0, max_words: int = 32,
                 memory_days: tuple | list = (1.0, 5.0, 25.0), trust_prior: float = 0.10, proof_sd: float = 0.0):
        self.H = int(horizon)
        self.bph = float(bars_per_hour)
        self.bar_ms = int(round(3_600_000 / self.bph))
        self.trust_prior = float(trust_prior)
        self.proof_sd = float(proof_sd)
        self.stats_all = [s for _, _, st in CHANNELS for s in st]
        self.D = len(self.stats_all)
        pos = {s: i for i, s in enumerate(self.stats_all)}
        self.base_keys = [s for s in self.stats_all if s not in MOOD_KEYS]
        self.base_pos = np.array([pos[s] for s in self.base_keys])
        self.mood_pos = np.array([pos[s] for s in MOOD_KEYS])
        self._get_base = itemgetter(*self.base_keys)
        self.vocab = _Vocab([(k, n, st, [pos[s] for s in st]) for k, n, st in CHANNELS], max_words, self.D)
        self.G = self.vocab.G
        self.lam_norm = 0.5 ** (1.0 / (NORM_DAYS * 24 * self.bph))
        self.norm: dict[str, list] = {}
        # meaning: hashed phrase table, one row per memory speed. Forgetting is a global scale per memory
        # (effective value = raw × scale), so no phrase has to be touched when time passes.
        self.memory_days = [float(x) for x in memory_days]
        self.lam_mem = np.array([0.5 ** (1.0 / (dd * 24 * self.bph)) for dd in self.memory_days])
        nm = len(self.memory_days)
        self.W = np.zeros((nm, TABLE))
        self.N = np.zeros((nm, TABLE))
        self.scale = np.ones(nm)
        self.T = 0
        self.clock_t = 0
        self.mix_loss = np.zeros(nm)
        self.mix_w = 0.0
        self.lam_mix = 0.5 ** (1.0 / MIX_HALFLIFE)
        self._hc: dict[tuple, int] = {}
        # what each market said
        self.prev: dict[str, list] = {}
        self.said: dict[str, float] = {}
        self.alpha = 1 - 0.5 ** (1.0 / max(1.0, self.H / 3.0))
        self.recent: dict[str, dict] = {}
        self.sentences: dict[str, deque] = {}
        self.pending: dict[str, deque] = {}
        self.cid: dict[str, int] = {}
        # attribution layouts (sense of every phrase; word × movement phrases count half for each)
        self._layout = {True: self._make_layout(True), False: self._make_layout(False)}
        # mood of all markets (cross-section of the last completed bar)
        self.cur_t = 0
        self.cur = np.zeros(8)
        self.mood = np.zeros(len(MOOD_KEYS))
        self.mood_hist: deque = deque(maxlen=288)
        # did it come true? conviction × direction cells, one observation per bar
        self.ms2_w = 0.0
        self.ms2 = 0.0
        self.lam_rms = 0.5 ** (1.0 / 20000.0)
        nc = 2 * (len(CONVICTION_EDGES) + 1)
        self.cell = np.zeros((nc, 4))                # w (bars), mean, var, n (statements)
        self.lam_cell = 0.5 ** (1.0 / TRUST_HALFLIFE_BARS)
        self.batch_t = None
        self.batch = np.zeros((nc, 2))
        # scoring
        self.acc_n = self.acc_hits = 0
        self.ic = [0.0] * 6
        self.ic_long = [0.0] * 6
        self.curve: list[dict] = []
        self.n_learned = self.n_read = self.n_scored = 0

    @property
    def rms(self) -> float:
        return math.sqrt(self.ms2) if self.ms2 > 0 else 0.0

    # ── sounds ────────────────────────────────────────────────────────────
    def _mood_collect(self, t: int, frow: dict) -> None:
        if t > self.cur_t:
            c = self.cur
            n = c[0]
            if n >= 3:
                mr = c[2] / n
                self.mood = np.array([c[1] / n, mr, math.sqrt(max(c[3] / n - mr * mr, 0.0)), c[4] / n, c[5] / n,
                                      c[6] / n, c[7] / n])
                self.mood_hist.append([int(self.cur_t)] + [round(float(x), 4) for x in self.mood])
            self.cur_t = t
            self.cur = np.zeros(8)
        if t == self.cur_t:
            r = max(-5.0, min(5.0, float(frow.get("ret_z", 0.0))))
            c = self.cur
            c[0] += 1
            c[1] += r > 0
            c[2] += r
            c[3] += r * r
            c[4] += abs(r)
            c[5] += max(-5.0, min(5.0, float(frow.get("vol_z", 0.0))))
            c[6] += max(-6.0, min(6.0, float(frow.get("funding_z", 0.0))))
            c[7] += max(-5.0, min(5.0, float(frow.get("ret_12n", 0.0))))

    def _sounds(self, coin: str, frow: dict, learn: bool) -> np.ndarray:
        """Every statistic relative to this market's own recent behaviour (z units, measured before learning).
        Returns D + 1 values (the last is the constant 0 used as padding by the vocabulary)."""
        x = np.empty(self.D)
        try:
            x[self.base_pos] = self._get_base(frow)
        except KeyError:
            x[self.base_pos] = [frow.get(k, 0.0) for k in self.base_keys]
        x[self.mood_pos] = self.mood
        if not np.isfinite(x).all():
            x[~np.isfinite(x)] = 0.0
        st = self.norm.get(coin)
        if st is None:
            st = self.norm[coin] = [x.copy(), np.zeros(self.D), 0.0]
        m, v, w = st
        z = np.zeros(self.D + 1)
        if w >= NORM_WARMUP:
            live = v > 1e-18 + 1e-10 * m * m
            z[: self.D] = np.clip(np.where(live, (x - m) / np.sqrt(np.where(live, v, 1.0)), 0.0), -4.0, 4.0)
        if learn:
            d = x - m
            if w >= NORM_WARMUP:                 # winsorise: one wild print cannot deafen the market
                lim = 5.0 * np.sqrt(v) + 1e-12
                d = np.clip(d, -lim, lim)
            w = self.lam_norm * w + 1.0
            a = 1.0 / w
            st[0] = m + a * d
            st[1] = (1 - a) * (v + a * d * d)
            st[2] = w
        return z

    # ── phrases ──────────────────────────────────────────────────────────
    def _hash(self, key: tuple) -> int:
        h = self._hc.get(key)
        if h is None:
            if len(self._hc) > 400_000:
                self._hc.clear()
            h = self._hc[key] = _h(*key)
        return h

    def _make_layout(self, with_prev: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Phrase order of a sentence → (phrase index, sense bucket, weight) for the attribution."""
        G = self.G
        pos, owner, wt = [0], [G + 1], [1.0]            # base tone
        i = 1
        for g in range(G):
            n = 3 if with_prev else 2                     # word, class dialect, (transition)
            for _ in range(n):
                pos.append(i)
                owner.append(g)
                wt.append(1.0)
                i += 1
            if g:                                         # word × movement word: half each
                pos += [i, i]
                owner += [g, 0]
                wt += [0.5, 0.5]
                i += 1
        pos += [i, i + 1]
        owner += [G, G]                                   # the market's own dialect
        wt += [1.0, 1.0]
        return np.array(pos), np.array(owner), np.array(wt)

    def _phrases(self, coin: str, cls: str, words: list[int], prev: list[int] | None) -> np.ndarray:
        """Hashed phrases of one sentence (order must match _make_layout)."""
        cid = self.cid.get(coin)
        if cid is None:
            cid = self.cid[coin] = _sid(coin)
        kid = self.cid.get("\0" + (cls or "-"))
        if kid is None:
            kid = self.cid["\0" + (cls or "-")] = _sid(cls or "-")
        hs = self._hash
        w0 = words[0]
        ids = [hs((1,))]
        for g in range(self.G):
            wg = words[g]
            ids.append(hs((2, g, wg)))
            ids.append(hs((8, kid, g, wg)))
            if prev is not None:
                ids.append(hs((3, g, prev[g], wg)))
            if g:
                ids.append(hs((4, g, wg, w0)))
        ids.append(hs((6, cid)))
        ids.append(hs((7, cid, w0)))
        return np.array(ids, dtype=np.int64)

    def _mix(self) -> np.ndarray:
        if self.mix_w <= 0:
            return np.full(len(self.lam_mem), 1.0 / len(self.lam_mem))
        e = np.exp(-MIX_ETA * (self.mix_loss - self.mix_loss.min()))
        return e / e.sum()

    def _cell(self, s: float) -> int:
        r = self.rms
        if r <= 0:
            return -1
        return sum(abs(s) / r >= e for e in CONVICTION_EDGES) + (len(CONVICTION_EDGES) + 1) * (s < 0)

    def trust(self, cell: int) -> tuple[float, float, float]:
        """(proven move in the statement's direction in σ·√H, raw realised mean, bars of evidence).

        Bayesian scepticism: prior N(0, trust_prior²) on the true edge of this conviction level, the realised
        mean per bar as evidence (consecutive outcomes overlap → H bars count as one), and the bot only takes
        what is *proven*: posterior mean minus ``proof_sd`` posterior standard deviations (0 = expected value)."""
        if cell < 0:
            return 0.0, 0.0, 0.0
        w, mean, var, _ = self.cell[cell]
        if w <= 0:
            return 0.0, 0.0, 0.0
        v0, w0 = TRUST_VAR_PRIOR
        var = (w * var + w0 * v0) / (w + w0)
        se2 = var / max(w / max(self.H, 1), 1e-9)
        tau2 = self.trust_prior ** 2
        shrink = tau2 / (tau2 + se2)
        return float(mean * shrink - self.proof_sd * math.sqrt(se2 * shrink)), float(mean), float(w)

    # ── reading ──────────────────────────────────────────────────────────
    def read(self, coin: str, t: int, frow: dict, learn: bool = True, pretrain: bool = False,
             cls: str = "") -> dict:
        """Hear the closed bar, put it into words, understand it, remember it for learning."""
        if learn:
            self._mood_collect(t, frow)
        z = self._sounds(coin, frow, learn)
        V = self.vocab
        slots = V.hear(z, t, learn)
        words = [int(u) for u in V.uid[V.rows, slots]]
        words = [w if j >= 0 else -1 for w, j in zip(words, slots.tolist())]
        prev = self.prev.get(coin)
        idx = self._phrases(coin, cls, words, prev)
        mix = self._mix()
        per = (mix * self.scale) @ self.W[:, idx]
        pred = float(per.sum())
        s_prev = self.said.get(coin)
        s = pred if s_prev is None else s_prev + self.alpha * (pred - s_prev)
        if learn:
            self.prev[coin] = words
            self.said[coin] = s
            self.ms2_w = self.lam_rms * self.ms2_w + 1.0
            self.ms2 += (s * s - self.ms2) / self.ms2_w
        cell = self._cell(s)
        believed, raw, bars = self.trust(cell)
        side = (1 if s > 0 else -1) if believed > 0 else 0
        vol = max(float(frow.get("vol", 1e-4)), 1e-6)
        exp_move = max(believed, 0.0) * vol * math.sqrt(self.H)
        lp, lo, lw = self._layout[prev is not None]
        by = np.bincount(lo, weights=per[lp] * lw, minlength=self.G + 2)   # senses, dialect, base tone
        slots_l = slots.tolist()
        out = {"pred": pred, "s": s, "side": side, "believed": believed, "raw": raw, "bars": bars, "cell": cell,
               "exp_move": exp_move, "contrib": by, "slots": slots_l}
        if learn:
            self.pending.setdefault(coin, deque()).append(
                {"idx": idx, "px": float(frow["close"]), "vol": vol, "pred": pred, "s": s, "cell": cell,
                 "age": 0, "t": t, "pre": pretrain})
            self.n_read += 1
            self.recent[coin] = {"t": t, "pred": pred, "s": s, "believed": believed, "bars": bars,
                                 "exp_bps": exp_move * 1e4, "contrib": by, "slots": slots_l}
            self.sentences.setdefault(coin, deque(maxlen=6)).append(slots_l)
        return out

    def names(self) -> list[str]:
        return list(self.vocab.names) + ["Eigenart", "Grundton"]

    def why(self, lp: dict, n: int = 6) -> list[tuple[str, float]]:
        return sorted(zip(self.names(), [round(float(c), 4) for c in lp["contrib"]]), key=lambda x: -abs(x[1]))[:n]

    def describe(self, lp: dict) -> str:
        """Human sentence for a reading: the senses that spoke in its direction and how well it has come true."""
        sd = 1 if lp["s"] >= 0 else -1
        V = self.vocab
        spoke = sorted(((c, g) for g, c in enumerate(lp["contrib"][: self.G]) if c * sd > 0), key=lambda x: -abs(x[0]))
        parts = [f"{V.names[g]} „{V.label(g, lp['slots'][g])}“" for _, g in spoke[:3]]
        return (" · ".join(parts) or "leise") + f" → bewährt {lp['believed']:+.2f} σ ({int(lp['bars'])} Bars Belege)"

    # ── learning ─────────────────────────────────────────────────────────
    def _advance_clock(self, t: int) -> None:
        if t > self.clock_t:
            if self.clock_t:
                steps = max(1, int(round((t - self.clock_t) / self.bar_ms)))
                self.T += steps
                self.scale *= self.lam_mem ** steps
                if self.scale.min() < 1e-150:          # fold the forgetting into the table (rare)
                    self.W *= self.scale[:, None]
                    self.N *= self.scale[:, None]
                    self.scale[:] = 1.0
            self.clock_t = t

    def on_bar(self, coin: str, close: float, t: int) -> int:
        self._advance_clock(t)
        q = self.pending.get(coin)
        if not q:
            return 0
        learned = 0
        for it in q:
            it["age"] += 1
        while q and q[0]["age"] >= self.H:
            it = q.popleft()
            ret = math.log(max(close, 1e-300) / max(it["px"], 1e-300))
            y = max(-4.0, min(4.0, ret / (it["vol"] * math.sqrt(self.H))))
            self._learn(it["idx"], y)
            if not it["pre"]:
                self._score(it, y, t)
            learned += 1
        self.n_learned += learned
        return learned

    def _learn(self, idx: np.ndarray, y: float) -> None:
        """Every memory fits all phrases of the sentence jointly on its residual (count-preconditioned)."""
        sc = self.scale[:, None]
        err = y - (self.W[:, idx] * sc).sum(1)
        self.mix_w = self.lam_mix * self.mix_w + 1.0
        self.mix_loss = self.lam_mix * self.mix_loss + np.minimum(err * err, 16.0)
        self.N[:, idx] += 1.0 / sc
        step = 1.0 / (self.N[:, idx] * sc + PRIOR_COUNT)
        step /= np.maximum(step.sum(1, keepdims=True), 1.0)
        self.W[:, idx] += step * np.clip(err, -4.0, 4.0)[:, None] / sc

    def _score(self, it: dict, y: float, t: int) -> None:
        pred = it["pred"]
        for s, lam in ((self.ic, 0.9995), (self.ic_long, 0.99998)):
            s[0] = lam * s[0] + 1.0
            a = 1.0 / s[0]
            s[1] += a * (pred - s[1])
            s[2] += a * (y - s[2])
            s[3] += a * (pred * pred - s[3])
            s[4] += a * (y * y - s[4])
            s[5] += a * (pred * y - s[5])
        r = self.rms
        if r > 0 and abs(it["s"]) >= r and y != 0:
            self.acc_n += 1
            self.acc_hits += (it["s"] > 0) == (y > 0)
        cell = it["cell"]
        if cell >= 0:   # did the statement come true? one observation per bar across all markets
            if self.batch_t is not None and it["t"] != self.batch_t:
                self._flush_batch()
            self.batch_t = it["t"]
            self.batch[cell, 0] += y if it["s"] > 0 else -y
            self.batch[cell, 1] += 1
        self.n_scored += 1
        if self.n_scored % 500 == 0:
            self.curve.append({"t": t, "n": self.n_scored, "ic": self.ic_value(), "ic_long": self.ic_value(True),
                               "hit": self.hit_rate(), "words": self.n_words()})
            if len(self.curve) > 2000:
                self.curve = self.curve[::2]

    def _flush_batch(self) -> None:
        for c in np.nonzero(self.batch[:, 1])[0]:
            r = self.batch[c, 0] / self.batch[c, 1]
            w, mean, var, n = self.cell[c]
            w = self.lam_cell * w + 1.0
            a = 1.0 / w
            d = r - mean
            self.cell[c] = [w, mean + a * d, (1 - a) * (var + a * d * d), n + self.batch[c, 1]]
        self.batch[:] = 0.0

    def ic_value(self, long: bool = False) -> float:
        _, mx, my, mxx, myy, mxy = self.ic_long if long else self.ic
        vx, vy = mxx - mx * mx, myy - my * my
        return float((mxy - mx * my) / math.sqrt(vx * vy)) if vx > 1e-12 and vy > 1e-12 else 0.0

    def hit_rate(self) -> float | None:
        return self.acc_hits / self.acc_n if self.acc_n else None

    def n_words(self) -> int:
        return int(self.vocab.k.sum())

    # ── insight ──────────────────────────────────────────────────────────
    def _meaning(self, ids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        ms = self._mix() * self.scale
        return ms @ self.W[:, ids], ms @ self.N[:, ids]

    def snapshot(self, coins: list[str] | None = None, top: int = 25) -> dict:
        V = self.vocab
        senses, transitions = [], []
        for g in range(self.G):
            k, d = int(V.k[g]), int(V.dg[g])
            st = V.stats[g]
            words = []
            if k:
                uids = [int(u) for u in V.uid[g, :k]]
                mean, cnt = self._meaning(np.array([_h(2, g, u) for u in uids], dtype=np.int64))
                share = V.use[g, :k] / max(float(V.use[g, :k].sum()), 1e-12)
                for j in range(k):
                    p = V.P[g, j, :d]
                    words.append({"code": V.code(g, j), "label": V.label(g, j), "share": round(float(share[j]), 4),
                                  "meaning": round(float(mean[j]), 4), "evidence": round(float(cnt[j]), 1),
                                  "born": int(V.born[g, j]),
                                  "sound": [[st[i], round(float(p[i]), 2)] for i in np.argsort(-np.abs(p))[:4]]})
                words.sort(key=lambda x: -x["share"])
                pairs = [(a, b) for a in range(k) for b in range(k)]
                tm, tc = self._meaning(np.array([_h(3, g, uids[a], uids[b]) for a, b in pairs], dtype=np.int64))
                for (a, b), m_, c_ in zip(pairs, tm.tolist(), tc.tolist()):
                    if c_ >= 50:
                        transitions.append((abs(m_) * math.sqrt(c_), V.names[g], f"{V.code(g, a)} → {V.code(g, b)}",
                                            f"{V.label(g, a)} → {V.label(g, b)}", m_, c_))
            senses.append({"key": V.keys[g], "name": V.names[g], "stats": st, "words": words,
                           "births": int(V.births[g]), "deaths": int(V.deaths[g]), "kmax": int(V.kmax[g])})
        transitions.sort(key=lambda x: -x[0])
        nb = len(CONVICTION_EDGES) + 1
        edges = (0.0,) + CONVICTION_EDGES
        cells = []
        for c in range(2 * nb):
            b = c % nb
            believed, raw, bars = self.trust(c)
            w, mean, var, n = self.cell[c]
            se = math.sqrt(max(var, 1e-6) / max(w / max(self.H, 1), 1e-9)) if w > 0 else None
            cells.append({"side": "long" if c < nb else "short", "lo": edges[b],
                          "hi": CONVICTION_EDGES[b] if b < nb - 1 else None, "believed": round(believed, 4),
                          "raw": round(raw, 4), "se": round(se, 4) if se else None, "bars": round(bars, 1),
                          "n": int(n)})
        names = self.names()
        now = {}
        for coin in (coins or list(self.recent))[:60]:
            r = self.recent.get(coin)
            if not r:
                continue
            words = [{"sense": V.names[g], "code": V.code(g, j), "label": V.label(g, j)}
                     for g, j in enumerate(r["slots"])]
            why = sorted(zip(names, [round(float(c), 4) for c in r["contrib"]]), key=lambda x: -abs(x[1]))[:4]
            hist = [[V.code(g, j) for g, j in enumerate(sl)] for sl in list(self.sentences.get(coin, []))[-4:]]
            now[coin] = {"t": r["t"], "pred": round(r["pred"], 4), "s": round(r["s"], 4),
                         "believed": round(r["believed"], 4), "bars": int(r["bars"]), "exp_bps": round(r["exp_bps"], 2),
                         "why": why, "words": words, "history": hist}
        mix = self._mix()
        return {
            "version": self.VERSION, "horizon": self.H, "learned": self.n_learned, "read": self.n_read,
            "ic": self.ic_value(), "ic_long": self.ic_value(True), "hit": self.hit_rate(), "hit_n": self.acc_n,
            "words": self.n_words(), "births": int(V.births.sum()), "deaths": int(V.deaths.sum()),
            "statistics": self.D,
            "memories": [{"name": nm, "days": d, "weight": round(float(w), 4)}
                         for nm, d, w in zip(MEMORY_NAMES, self.memory_days, mix)],
            "mood": {k: round(float(v), 4) for k, v in zip(MOOD_KEYS, self.mood)}, "mood_text": MOOD_TEXT,
            "mood_hist": list(self.mood_hist)[-96:], "senses": senses, "short": SHORT,
            "transitions": [{"sense": s, "codes": c, "text": tx, "meaning": round(m, 4), "evidence": round(n, 1)}
                            for _, s, c, tx, m, n in transitions[:top]],
            "trust": cells, "trust_prior": self.trust_prior, "proof_sd": self.proof_sd, "rms": round(self.rms, 4),
            "now": now,
            "curve": self.curve[-500:], "duplicates": DUPLICATES,
        }

    # ── persistence ──────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        sc = self.scale[:, None]
        return {"version": self.VERSION, "H": self.H, "bph": self.bph, "D": self.D, "T": self.T,
                "clock_t": self.clock_t, "memory_days": self.memory_days,
                "W": _pack(self.W * sc), "N": _pack(self.N * sc), "mix_loss": self.mix_loss.tolist(),
                "mix_w": self.mix_w, "vocab": self.vocab.to_dict(),
                "norm": {c: [st[0].tolist(), st[1].tolist(), st[2]] for c, st in self.norm.items()},
                "prev": self.prev, "said": self.said, "mood": self.mood.tolist(), "ms2": [self.ms2_w, self.ms2],
                "cell": self.cell.tolist(), "batch": self.batch.tolist(), "batch_t": self.batch_t,
                "acc": [self.acc_n, self.acc_hits], "ic": self.ic, "ic_long": self.ic_long,
                "curve": self.curve[-500:], "n": [self.n_learned, self.n_read, self.n_scored]}

    def load(self, d: dict) -> None:
        if not d or d.get("version") != self.VERSION or d.get("H") != self.H or d.get("D") != self.D \
                or abs(float(d.get("bph", 0)) - self.bph) > 1e-9 or list(d.get("memory_days", [])) != self.memory_days:
            return
        try:
            W, N = _unpack(d["W"], self.W.shape), _unpack(d["N"], self.N.shape)
        except (ValueError, zlib.error, KeyError, TypeError):
            return
        self.W, self.N = W, N
        self.scale[:] = 1.0
        self.T = int(d["T"])
        self.clock_t = int(d.get("clock_t", 0))
        self.mix_loss = np.asarray(d.get("mix_loss", self.mix_loss), dtype=float)
        self.mix_w = float(d.get("mix_w", 0.0))
        self.vocab.load(d.get("vocab", {}))
        self.norm = {c: [np.asarray(v[0], float), np.asarray(v[1], float), float(v[2])]
                     for c, v in d.get("norm", {}).items() if len(v[0]) == self.D}
        self.prev = {c: [int(x) for x in w] for c, w in d.get("prev", {}).items() if len(w) == self.G}
        self.said = {c: float(v) for c, v in d.get("said", {}).items()}
        if len(d.get("mood", [])) == len(MOOD_KEYS):
            self.mood = np.asarray(d["mood"], dtype=float)
        self.ms2_w, self.ms2 = (float(x) for x in d.get("ms2", [0.0, 0.0]))
        for key in ("cell", "batch"):
            arr = np.asarray(d.get(key, []), dtype=float)
            if arr.shape == getattr(self, key).shape:
                setattr(self, key, arr)
        self.batch_t = d.get("batch_t")
        self.acc_n, self.acc_hits = (int(x) for x in d.get("acc", [0, 0]))
        if len(d.get("ic", [])) == 6:
            self.ic = [float(x) for x in d["ic"]]
        if len(d.get("ic_long", [])) == 6:
            self.ic_long = [float(x) for x in d["ic_long"]]
        self.curve = list(d.get("curve", []))
        self.n_learned, self.n_read, self.n_scored = (int(x) for x in d.get("n", [0, 0, 0]))
