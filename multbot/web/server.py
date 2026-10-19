"""Dashboard server (Starlette): REST endpoints + WebSocket push of the live engine state."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import deque
from pathlib import Path

import numpy as np
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..config import Config
from ..engine.runner import BaseRunner
from ..features import indicators as ta
from ..features.pipeline import FEATURES, ML_FEATURES
from ..features.stats import kalman_trend
from ..learning.brain import META_FEATURES
from ..research.report import run_research
from ..strategies.library import catalog

log = logging.getLogger("multbot.web")
STATIC = Path(__file__).parent / "static"


def clean(o):
    """Make any engine structure JSON-safe (NaN/inf → None, numpy → python, deque/tuple → list)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, deque, set)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating,)):
        v = float(o)
        return v if math.isfinite(v) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    return o


class JSON(Response):
    media_type = "application/json"

    def render(self, content) -> bytes:
        return json.dumps(clean(content), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def create_app(cfg: Config, runner: BaseRunner) -> Starlette:
    research_state = {"running": False, "progress": 0.0, "error": None, "report": None}
    lab_state = {"running": False, "progress": 0.0, "error": None, "report": None}
    lang_cache = {"ts": 0.0, "data": None}

    def load_lab():
        p = cfg.data_path("research", "lab_latest.json")
        if p.exists():
            try:
                return json.loads(p.read_text())
            except json.JSONDecodeError:
                return None
        return None

    def load_research():
        for name in ("research_latest.json", f"pretrain_{runner.run_id}.json"):
            p = cfg.data_path("research", name)
            if p.exists():
                try:
                    return json.loads(p.read_text())
                except json.JSONDecodeError:
                    continue
        return runner.pretrain

    async def index(_: Request):
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    async def manifest(_: Request):
        return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")

    async def service_worker(_: Request):
        # served from the root so its scope covers the whole terminal
        return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})

    async def favicon(_: Request):
        return FileResponse(STATIC / "favicon.ico", media_type="image/x-icon")

    async def state(_: Request):
        return JSON(snapshot())

    def snapshot() -> dict:
        info = runner.info()
        if not runner.engine:
            return {"ready": False, "info": info}
        snap = runner.engine.snapshot()
        snap["ready"] = True
        snap["info"] = info
        snap["research_running"] = research_state["running"]
        snap["research_progress"] = research_state["progress"]
        return snap

    async def brain(_: Request):
        if not runner.engine:
            return JSON({"ready": False})
        d = runner.brain.snapshot(asset_limit=30)   # hundreds of markets: IC table of the best-observed ones
        d["ready"] = True
        d["catalog"] = catalog()
        d["feature_desc"] = FEATURES
        d["ml_features"] = ML_FEATURES
        d["meta_features"] = META_FEATURES
        return JSON(d)

    async def asset(request: Request):
        coin = request.path_params["coin"]
        if not runner.engine or coin not in runner.series:
            return JSON({"error": "unbekannt"}, status_code=404)
        n = int(request.query_params.get("n", 300))
        runner.watch_coin(coin)
        a = runner.series[coin].arrays(last=max(n + 200, 400))
        c = a["c"]
        mid, up, lo, _ = ta.bollinger(c, 20, 2.0)
        lvl, _, _ = kalman_trend(c)
        out = {
            "coin": coin, "t": a["t"][-n:], "o": a["o"][-n:], "h": a["h"][-n:], "l": a["l"][-n:], "c": c[-n:],
            "v": a["v"][-n:], "ema21": ta.ema(c, 21)[-n:], "ema55": ta.ema(c, 55)[-n:], "bb_up": up[-n:],
            "bb_lo": lo[-n:], "bb_mid": mid[-n:], "kalman": lvl[-n:], "rsi": ta.rsi(c, 14)[-n:],
            "vwap": ta.rolling_vwap(a["h"], a["l"], c, a["v"], 48)[-n:],
        }
        cur = runner.cur.get(coin)
        if cur:
            out["forming"] = cur
        e = runner.engine
        m = runner.micro[coin]
        out["view"] = e.view_dict(coin)
        out["book"] = m.book_snapshot(20)
        out["book_ok"] = e.exec.book_fresh(coin, runner.now())
        out["position"] = next((p for p in e.positions_view() if p["coin"] == coin), None)
        out["order"] = {k: v for k, v in e.pending_orders[coin].items() if k not in ("d", "meta_x")} \
            if coin in e.pending_orders else None
        out["trades"] = [t for t in e.trades if t["coin"] == coin][-100:]
        out["journal"] = [j for j in e.journal if j["coin"] == coin][-80:]
        out["spec"] = runner.specs[coin].to_dict()
        out["flow"] = list(m.trades)[-80:]
        out["calib"] = runner.calib.get(coin, {})
        out["weights"] = runner.brain.weights(coin, (out["view"]["regime"] or {}).get("label", "NEUTRAL-MID"))
        return JSON(out)

    async def signals(request: Request):
        if not runner.engine:
            return JSON({"keys": [], "rows": []})
        limit = int(request.query_params.get("limit", 60))
        q = request.query_params.get("q", "").upper()
        coins = None
        if q:
            coins = [c for c in runner.specs if q in c.upper()]
        return JSON(runner.engine.signals_matrix(limit, coins))

    async def research(_: Request):
        rep = research_state["report"] or load_research()
        return JSON({"report": rep, "running": research_state["running"], "progress": research_state["progress"],
                     "error": research_state["error"]})

    async def research_run(request: Request):
        if research_state["running"]:
            return JSON({"ok": False, "msg": "läuft bereits"})
        body = {}
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            pass

        async def job():
            research_state.update(running=True, progress=0.0, error=None)
            try:
                from ..config import load_config
                rcfg = load_config(getattr(cfg, "_path", "config.yaml"), {"data_dir": cfg.data_dir})
                if body.get("entry_mode") in ("maker", "taker"):
                    rcfg.execution.entry_mode = body["entry_mode"]

                def prog(x):
                    research_state["progress"] = round(x, 3)

                coins = body.get("coins") or None
                rep = await run_research(rcfg, body.get("interval"), body.get("bars"), progress=prog,
                                         top=body.get("top"), coins=coins)
                research_state["report"] = rep
            except Exception as e:  # noqa: BLE001
                log.exception("Research fehlgeschlagen")
                research_state["error"] = str(e)
            finally:
                research_state["running"] = False

        asyncio.create_task(job())
        return JSON({"ok": True})

    async def language(_: Request):
        if not runner.engine:
            return JSON({"ready": False})
        if time.time() - lang_cache["ts"] < 4 and lang_cache["data"]:
            return JSON(lang_cache["data"])
        coins = sorted(runner.specs, key=lambda c: -runner.specs[c].day_volume)
        snap = runner.brain.lang.snapshot(coins, 30)   # in the event loop: the model is not thread-safe
        snap["ready"] = True
        snap["mode"] = cfg.signal.mode
        for c, x in snap["now"].items():
            v = runner.engine.views.get(c)
            x["status"] = v.status if v is not None else ""
            x["exp_roe"] = v.exp_roe if v is not None else None
        lang_cache.update(ts=time.time(), data=snap)
        return JSON(snap)

    async def lab(_: Request):
        rep = lab_state["report"] or load_lab()
        return JSON({"report": rep, "running": lab_state["running"], "progress": lab_state["progress"],
                     "error": lab_state["error"]})

    async def lab_run(request: Request):
        if lab_state["running"]:
            return JSON({"ok": False, "msg": "läuft bereits"})
        body = {}
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            pass

        async def job():
            from ..research.lab import run_lab_live
            lab_state.update(running=True, progress=0.0, error=None)
            try:
                def prog(x):
                    lab_state["progress"] = round(x, 3)
                lab_state["report"] = await run_lab_live(cfg, body.get("top"), int(body.get("bars") or 5000), prog)
            except Exception as e:  # noqa: BLE001
                log.exception("Alpha-Labor fehlgeschlagen")
                lab_state["error"] = str(e)
            finally:
                lab_state["running"] = False

        asyncio.create_task(job())
        return JSON({"ok": True})

    async def export_trades(_: Request):
        """All closed trades of this run as CSV (Excel / Numbers / Google Sheets)."""
        import csv
        import io
        rows = runner.store.trades(runner.run_id, 1_000_000) if runner.store else []
        cols = ["entry_ms", "exit_ms", "coin", "side", "leverage", "size", "entry_px", "exit_px", "margin", "pnl",
                "fees", "funding", "net", "roe", "r_multiple", "reason", "regime", "score", "pwin", "mae", "mfe",
                "epoch"]
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(["entry_utc", "exit_utc"] + cols[2:] + ["exp_roe", "rank"])
        from datetime import datetime, timezone
        iso = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if ms else ""
        for r in rows:
            dec = (r.get("detail") or {}).get("decision") or {}
            rk = dec.get("rank")
            w.writerow([iso(r.get("entry_ms")), iso(r.get("exit_ms"))] + [r.get(c) for c in cols[2:]] +
                       [dec.get("exp_roe"), f"{rk[0]}/{rk[1]}" if rk else ""])
        return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="mult-q2-trades-{runner.run_id}.csv"'})

    async def history(request: Request):
        kind = request.path_params["kind"]
        if not runner.store:
            return JSON([])
        if kind == "trades":
            return JSON(runner.store.trades(runner.run_id, 5000))
        if kind == "journal":
            return JSON(runner.store.journal(runner.run_id, int(request.query_params.get("n", 1000))))
        if kind == "equity":
            return JSON(runner.store.equity(runner.run_id))
        if kind == "learning":
            return JSON(runner.store.learning(runner.run_id, 3000))
        return JSON({"error": "unbekannt"}, status_code=404)

    async def corr(_: Request):
        if not runner.engine:
            return JSON({})
        return JSON(runner.engine.corr_matrix())

    async def config(_: Request):
        return JSON({"config": cfg.to_dict(), "specs": {c: s.to_dict() for c, s in runner.specs.items()},
                     "calib": runner.calib})

    async def control(request: Request):
        body = await request.json()
        msg = runner.control(str(body.get("action", "")), body.get("coin"))
        runner.persist(force=True)
        return JSON({"ok": True, "msg": msg})

    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                await ws.send_text(json.dumps(clean(snapshot()), ensure_ascii=False, separators=(",", ":")))
                await asyncio.sleep(cfg.web.push_interval_s)
        except (WebSocketDisconnect, RuntimeError, ConnectionError):
            return
        except Exception:  # noqa: BLE001
            log.exception("WebSocket-Push fehlgeschlagen")

    routes = [
        Route("/", index),
        Route("/manifest.webmanifest", manifest),
        Route("/sw.js", service_worker),
        Route("/favicon.ico", favicon),
        Route("/api/state", state),
        Route("/api/brain", brain),
        Route("/api/asset/{coin:path}", asset),
        Route("/api/signals", signals),
        Route("/api/research", research),
        Route("/api/research/run", research_run, methods=["POST"]),
        Route("/api/lab", lab),
        Route("/api/language", language),
        Route("/api/export/trades.csv", export_trades),
        Route("/api/lab/run", lab_run, methods=["POST"]),
        Route("/api/history/{kind}", history),
        Route("/api/corr", corr),
        Route("/api/config", config),
        Route("/api/control", control, methods=["POST"]),
        WebSocketRoute("/ws", ws_endpoint),
        Mount("/static", StaticFiles(directory=str(STATIC)), name="static"),
    ]
    return Starlette(routes=routes)
