"""SQLite persistence: trades, equity curve, decision journal, learning curve, key/value state."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run TEXT, epoch INTEGER, coin TEXT, side INTEGER, size REAL, leverage INTEGER,
    entry_px REAL, exit_px REAL, entry_ms INTEGER, exit_ms INTEGER, margin REAL,
    pnl REAL, fees REAL, funding REAL, net REAL, roe REAL, r_multiple REAL,
    reason TEXT, regime TEXT, score REAL, pwin REAL, mae REAL, mfe REAL, detail TEXT
);
CREATE TABLE IF NOT EXISTS equity (
    run TEXT, ts INTEGER, epoch INTEGER, equity REAL, balance REAL, upnl REAL, margin REAL
);
CREATE INDEX IF NOT EXISTS equity_ts ON equity(run, ts);
CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, ts INTEGER, coin TEXT, kind TEXT, text TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS learning (
    run TEXT, ts INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT
);
"""


class Store:
    def __init__(self, path: str | Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    def close(self) -> None:
        with self.lock:
            self.conn.commit()
            self.conn.close()

    def _exec(self, sql: str, params: tuple = ()) -> None:
        with self.lock:
            self.conn.execute(sql, params)

    def commit(self) -> None:
        with self.lock:
            self.conn.commit()

    # ── writes ────────────────────────────────────────────────────────────
    def add_trade(self, run: str, t: dict) -> None:
        self._exec(
            "INSERT INTO trades (run, epoch, coin, side, size, leverage, entry_px, exit_px, entry_ms, exit_ms,"
            " margin, pnl, fees, funding, net, roe, r_multiple, reason, regime, score, pwin, mae, mfe, detail)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run, t["epoch"], t["coin"], t["side"], t["size"], t["leverage"], t["entry_px"], t["exit_px"],
             t["entry_ms"], t["exit_ms"], t["margin"], t["pnl"], t["fees"], t["funding"], t["net"], t["roe"],
             t["r_multiple"], t["reason"], t.get("regime", ""), t.get("score", 0.0), t.get("pwin", 0.0),
             t.get("mae", 0.0), t.get("mfe", 0.0), json.dumps(t.get("detail", {}))),
        )

    def add_equity(self, run: str, ts: int, epoch: int, equity: float, balance: float, upnl: float,
                   margin: float) -> None:
        self._exec("INSERT INTO equity VALUES (?,?,?,?,?,?,?)", (run, ts, epoch, equity, balance, upnl, margin))

    def add_journal(self, run: str, ts: int, coin: str, kind: str, text: str, detail: Any = None) -> None:
        self._exec("INSERT INTO journal (run, ts, coin, kind, text, detail) VALUES (?,?,?,?,?,?)",
                   (run, ts, coin, kind, text, json.dumps(detail or {})))

    def add_learning(self, run: str, ts: int, detail: dict) -> None:
        self._exec("INSERT INTO learning VALUES (?,?,?)", (run, ts, json.dumps(detail)))

    def set_kv(self, key: str, value: Any) -> None:
        self._exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (key, json.dumps(value)))

    # ── reads ─────────────────────────────────────────────────────────────
    def get_kv(self, key: str, default: Any = None) -> Any:
        with self.lock:
            row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def trades(self, run: str, limit: int = 1000) -> list[dict]:
        with self.lock:
            cur = self.conn.execute("SELECT * FROM trades WHERE run=? ORDER BY id DESC LIMIT ?", (run, limit))
            cols = [c[0] for c in cur.description]
            rows = cur.fetchall()
        out = []
        for r in rows:
            d = dict(zip(cols, r))
            d["detail"] = json.loads(d["detail"] or "{}")
            out.append(d)
        return out[::-1]

    def equity(self, run: str, limit: int = 20000) -> list[tuple]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts, epoch, equity, balance, upnl, margin FROM equity WHERE run=? ORDER BY ts DESC LIMIT ?",
                (run, limit)).fetchall()
        return rows[::-1]

    def journal(self, run: str, limit: int = 500) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts, coin, kind, text, detail FROM journal WHERE run=? ORDER BY id DESC LIMIT ?",
                (run, limit)).fetchall()
        return [{"ts": r[0], "coin": r[1], "kind": r[2], "text": r[3], "detail": json.loads(r[4] or "{}")}
                for r in rows[::-1]]

    def learning(self, run: str, limit: int = 5000) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT ts, detail FROM learning WHERE run=? ORDER BY ts DESC LIMIT ?",
                                     (run, limit)).fetchall()
        return [{"ts": r[0], **json.loads(r[1])} for r in rows[::-1]]
