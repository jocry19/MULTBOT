"""Marktsprache – the bot reads the market like a language it learns to speak, without fixed strategies.

**Alphabet.** Every closed bar of every market becomes a *word* of three letters, each measured relative to
that market's own recent behaviour (nothing is a fixed price level or indicator threshold):

* move   (5): the bar's return in units of the market's volatility        ⇊  ↓  ·  ↑  ⇈
* volume (3): the bar's volume against its own recent volume               ◦ quiet · normal ● loud
* range  (3): the bar's high–low span against its volatility               ▁ tight ▄ normal █ wide

→ 45 words. The **mood** of the whole market adds context: how many markets rose in the last completed bar
(risk-off / mixed / risk-on) and how hectic they were (calm / normal / hectic) → 9 moods.

**Grammar.** An online variable-order context model – the principle of predictive text: for every phrase
(the last word, the last two, the last three words, with and without the mood, and each market's own
*dialect*) it keeps an exponentially forgetting average of what came next: the move over the horizon in units
of volatility. A prediction backs off from long, specific phrases to short, general ones (Bayesian shrinkage),
weighted by how much evidence each phrase has. Nothing is decided in advance: phrases that stop working fade
away (forgetting), new ones emerge as the market starts speaking differently.

**Speaking** = trading: a direction is only "said" when the learned phrase predicts a move that is large and
well-supported enough; the engine then still demands that the expected move beats the costs.
"""
from __future__ import annotations

import math
from collections import deque

import numpy as np

MOVE_EDGES = (-1.5, -0.5, 0.5, 1.5)      # ret_z buckets
VOLUME_EDGES = (-0.75, 0.75)              # vol_z (log volume z-score) buckets
RANGE_EDGES = (0.8, 2.0)                  # rng_z buckets
BREADTH_EDGES = (0.35, 0.65)              # share of markets up in the last bar
ACTIVITY_EDGES = (0.6, 1.2)               # mean |ret_z| across markets in the last bar

MOVE_SYM = ("⇊", "↓", "·", "↑", "⇈")
VOLUME_SYM = ("◦", "•", "●")
RANGE_SYM = ("▁", "▄", "█")
MOOD_BREADTH = ("Risk-off", "gemischt", "Risk-on")
MOOD_ACTIVITY = ("ruhig", "normal", "hektisch")
MOVE_WORD = ("stark fallend", "fallend", "seitwärts", "steigend", "stark steigend")
VOLUME_WORD = ("leise", "normales Volumen", "laut")
RANGE_WORD = ("enge Spanne", "normale Spanne", "weite Spanne")

N_WORDS = len(MOVE_SYM) * len(VOLUME_SYM) * len(RANGE_SYM)
N_MOODS = len(MOOD_BREADTH) * len(MOOD_ACTIVITY)
# memory per phrase order, in updates of that phrase (≈ how long a phrase "remembers")
HALFLIFE = {"m": 20000.0, "1": 4000.0, "2": 1500.0, "3": 800.0, "d": 400.0}


def _bucket(x: float, edges: tuple) -> int:
    return sum(x >= e for e in edges)


def word_of(frow: dict) -> int:
    m = _bucket(frow.get("ret_z", 0.0), MOVE_EDGES)
    v = _bucket(frow.get("vol_z", 0.0), VOLUME_EDGES)
    r = _bucket(frow.get("rng_z", 1.0), RANGE_EDGES)
    return (m * len(VOLUME_SYM) + v) * len(RANGE_SYM) + r


def word_symbol(w: int) -> str:
    m, rest = divmod(w, len(VOLUME_SYM) * len(RANGE_SYM))
    v, r = divmod(rest, len(RANGE_SYM))
    return MOVE_SYM[m] + VOLUME_SYM[v] + RANGE_SYM[r]


def word_text(w: int) -> str:
    m, rest = divmod(w, len(VOLUME_SYM) * len(RANGE_SYM))
    v, r = divmod(rest, len(RANGE_SYM))
    return f"{MOVE_WORD[m]}, {VOLUME_WORD[v]}, {RANGE_WORD[r]}"


def mood_text(md: int) -> str:
    b, a = divmod(md, len(MOOD_ACTIVITY))
    return f"{MOOD_BREADTH[b]}, {MOOD_ACTIVITY[a]}"


class _Stat:
    """Exponentially forgetting mean / second moment of the outcome after a phrase."""

    __slots__ = ("w", "m", "q", "n")

    def __init__(self):
        self.w = self.m = self.q = 0.0
        self.n = 0

    def add(self, y: float, lam: float) -> None:
        self.w = lam * self.w + 1.0
        a = 1.0 / self.w
        self.m += a * (y - self.m)
        self.q += a * (y * y - self.q)
        self.n += 1

    @property
    def var(self) -> float:
        return max(self.q - self.m * self.m, 1e-6)

    def to_list(self) -> list:
        return [round(self.w, 4), round(self.m, 6), round(self.q, 6), self.n]

    @classmethod
    def from_list(cls, x: list) -> "_Stat":
        s = cls()
        s.w, s.m, s.q, s.n = float(x[0]), float(x[1]), float(x[2]), int(x[3])
        return s


class MarketLanguage:
    VERSION = 1

    def __init__(self, horizon: int, kappa: float = 100.0, kappa_dialect: float = 300.0, z_full: float = 4.0):
        self.H = int(horizon)
        self.kappa = kappa
        self.kappa_d = kappa_dialect
        self.z_full = z_full
        self.lam = {k: 0.5 ** (1.0 / hl) for k, hl in HALFLIFE.items()}
        self.stats: dict[tuple, _Stat] = {}
        self.words: dict[str, deque] = {}            # last three words per market
        self.pending: dict[str, deque] = {}
        self.cur_t = 0
        self.cur = [0, 0, 0.0]                       # ups, markets, Σ|ret_z| of the bar being collected
        self.mood = 4                                # mood of the last completed bar (start: mixed, normal)
        self.mood_hist: deque = deque(maxlen=288)
        self.acc_n = 0                               # online accuracy of the language's own predictions
        self.acc_hits = 0
        self.ic = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]     # EW sums for corr(prediction, outcome)
        self.curve: list[dict] = []
        self.n_learned = 0

    # ── reading ──────────────────────────────────────────────────────────
    def _mood_update(self, t: int, ret_z: float) -> None:
        if t > self.cur_t:
            ups, n, act = self.cur
            if n >= 3:
                self.mood = _bucket(ups / n, BREADTH_EDGES) * len(MOOD_ACTIVITY) + _bucket(act / n, ACTIVITY_EDGES)
                self.mood_hist.append((self.cur_t, self.mood, round(ups / n, 3), round(act / n, 3)))
            self.cur_t, self.cur = t, [0, 0, 0.0]
        if t == self.cur_t:
            self.cur[0] += ret_z > 0
            self.cur[1] += 1
            self.cur[2] += min(abs(ret_z), 5.0)

    def _contexts(self, coin: str, ws: deque, md: int) -> list[tuple]:
        w = list(ws)
        ctx = [("m", md)]
        if len(w) >= 1:
            ctx.append(("1", w[-1], md))
        if len(w) >= 2:
            ctx.append(("2", w[-2], w[-1], md))
        if len(w) >= 3:
            ctx.append(("3", w[-3], w[-2], w[-1]))
        if len(w) >= 1:
            ctx.append(("d", coin, w[-1]))
        return ctx

    def predict(self, contexts: list[tuple]) -> tuple[float, float, int]:
        """(expected outcome in σ·√H units, confidence z, evidence of the most specific phrase)."""
        mu, best_w, var = 0.0, 0.0, 1.0
        for c in contexts:
            s = self.stats.get(c)
            if c[0] == "m" and s is not None and s.w > 50:
                var = s.var
            if s is None or s.w <= 0:
                continue
            k = self.kappa_d if c[0] == "d" else self.kappa
            mu = (s.w * s.m + k * mu) / (s.w + k)
            if c[0] != "m":
                best_w = max(best_w, s.w)
        se = math.sqrt(var / (self.kappa + best_w))
        return mu, mu / se if se > 0 else 0.0, int(best_w)

    def read(self, coin: str, t: int, frow: dict, learn: bool = True, pretrain: bool = False) -> dict:
        """Turn the closed bar into a word, predict what the market will say next, remember it for learning."""
        rz = float(frow.get("ret_z", 0.0))
        self._mood_update(t, rz)
        w = word_of(frow)
        ws = self.words.setdefault(coin, deque(maxlen=3))
        ws.append(w)
        ctx = self._contexts(coin, ws, self.mood)
        mu, z, ev = self.predict(ctx)
        vol = max(float(frow.get("vol", 1e-4)), 1e-6)
        if learn:
            self.pending.setdefault(coin, deque()).append(
                {"ctx": ctx, "px": float(frow["close"]), "vol": vol, "mu": mu, "z": z, "age": 0, "pre": pretrain})
        final = math.copysign(min(1.0, abs(z) / self.z_full), mu) if mu else 0.0
        return {"word": w, "mood": self.mood, "mu": mu, "z": z, "evidence": ev, "final": final,
                "exp_move": abs(mu) * vol * math.sqrt(self.H), "sentence": list(ws)}

    # ── learning ─────────────────────────────────────────────────────────
    def on_bar(self, coin: str, close: float, t: int) -> int:
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
            for c in it["ctx"]:
                s = self.stats.get(c)
                if s is None:
                    s = self.stats[c] = _Stat()
                s.add(y, self.lam[c[0]])
            if not it["pre"]:
                self._score(it["mu"], it["z"], y, t)
            learned += 1
        self.n_learned += learned
        return learned

    def _score(self, mu: float, z: float, y: float, t: int) -> None:
        lam = 0.9995
        s = self.ic
        s[0] = lam * s[0] + 1.0
        a = 1.0 / s[0]
        s[1] += a * (mu - s[1])
        s[2] += a * (y - s[2])
        s[3] += a * (mu * mu - s[3])
        s[4] += a * (y * y - s[4])
        s[5] += a * (mu * y - s[5])
        if abs(z) >= 1.0 and y != 0:
            self.acc_n += 1
            self.acc_hits += (mu > 0) == (y > 0)
        if self.n_learned % 500 == 0:
            self.curve.append({"t": t, "n": self.n_learned, "ic": self.ic_value(), "hit": self.hit_rate(),
                               "phrases": len(self.stats)})
            if len(self.curve) > 2000:
                self.curve = self.curve[::2]

    def ic_value(self) -> float:
        _, mx, my, mxx, myy, mxy = self.ic
        vx, vy = mxx - mx * mx, myy - my * my
        return float((mxy - mx * my) / math.sqrt(vx * vy)) if vx > 1e-12 and vy > 1e-12 else 0.0

    def hit_rate(self) -> float | None:
        return self.acc_hits / self.acc_n if self.acc_n else None

    # ── insight ──────────────────────────────────────────────────────────
    def phrase_text(self, c: tuple) -> str:
        if c[0] == "m":
            return f"Stimmung {mood_text(c[1])}"
        if c[0] == "d":
            return f"{c[1]}: {word_symbol(c[2])}"
        words = c[1:-1] if c[0] in ("1", "2") else c[1:]
        txt = " → ".join(word_symbol(w) for w in words)
        return txt + (f"  [{mood_text(c[-1])}]" if c[0] in ("1", "2") else "")

    def snapshot(self, coins: list[str] | None = None, top: int = 25) -> dict:
        vocab = []
        for w in range(N_WORDS):
            tot_w = tot_m = 0.0
            for md in range(N_MOODS):
                s = self.stats.get(("1", w, md))
                if s:
                    tot_w += s.w
                    tot_m += s.w * s.m
            vocab.append({"w": w, "sym": word_symbol(w), "text": word_text(w), "weight": round(tot_w, 1),
                          "mean": round(tot_m / tot_w, 4) if tot_w else None})
        phrases = []
        for c, s in self.stats.items():
            if c[0] in ("2", "3") and s.w >= 40:
                t = s.m / math.sqrt(s.var / s.w)
                phrases.append((abs(t), c, s, t))
        phrases.sort(key=lambda x: -x[0])
        moods = []
        for md in range(N_MOODS):
            s = self.stats.get(("m", md))
            moods.append({"mood": md, "text": mood_text(md), "weight": round(s.w, 1) if s else 0,
                          "mean": round(s.m, 4) if s else None})
        sentences = {}
        for coin in (coins or list(self.words))[:60]:
            ws = self.words.get(coin)
            if ws:
                sentences[coin] = [word_symbol(w) for w in ws]
        return {
            "horizon": self.H, "phrases_known": len(self.stats), "learned": self.n_learned, "ic": self.ic_value(),
            "hit": self.hit_rate(), "hit_n": self.acc_n, "mood": self.mood, "mood_text": mood_text(self.mood),
            "mood_hist": list(self.mood_hist)[-96:], "vocab": vocab, "moods": moods,
            "top_phrases": [{"text": self.phrase_text(c), "order": c[0], "mean": round(s.m, 4), "t": round(t, 2),
                             "weight": round(s.w, 1)} for _, c, s, t in phrases[:top]],
            "sentences": sentences, "curve": self.curve[-500:],
            "legend": {"move": dict(zip(MOVE_SYM, MOVE_WORD)), "volume": dict(zip(VOLUME_SYM, VOLUME_WORD)),
                       "range": dict(zip(RANGE_SYM, RANGE_WORD))},
        }

    # ── persistence ──────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {"version": self.VERSION, "H": self.H,
                "stats": [[list(c), s.to_list()] for c, s in self.stats.items() if s.w > 0.5],
                "words": {c: list(w) for c, w in self.words.items()}, "mood": self.mood,
                "acc": [self.acc_n, self.acc_hits], "ic": self.ic, "curve": self.curve[-500:],
                "n_learned": self.n_learned}

    def load(self, d: dict) -> None:
        if not d or d.get("version") != self.VERSION or d.get("H") != self.H:
            return
        self.stats = {tuple(c): _Stat.from_list(x) for c, x in d.get("stats", [])}
        for c, w in d.get("words", {}).items():
            self.words[c] = deque(w, maxlen=3)
        self.mood = int(d.get("mood", 4))
        self.acc_n, self.acc_hits = (int(x) for x in d.get("acc", [0, 0]))
        if len(d.get("ic", [])) == 6:
            self.ic = [float(x) for x in d["ic"]]
        self.curve = list(d.get("curve", []))
        self.n_learned = int(d.get("n_learned", 0))
