"""Command line interface.

    python -m multbot run          # live paper trading on Hyperliquid data + terminal dashboard
    python -m multbot sim          # offline simulation with a synthetic market (accelerated)
    python -m multbot research     # walk-forward backtest, Monte Carlo, signal research
    python -m multbot markets      # live market table for the configured assets
    python -m multbot report       # account summary from the database
    python -m multbot shortcut     # desktop shortcut that opens the terminal as an app window
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .config import load_config
from .util import fmt_ts, setup_logging

log = logging.getLogger("multbot")

BANNER = r"""
 __  __ _   _ _   _____ ____   ___ _____
|  \/  | | | | | |_   _| __ ) / _ \_   _|   Perpetual Signal Bot · Paper-Trading
| |\/| | | | | |   | | |  _ \| | | || |     Hyperliquid (inkl. HIP-3 xyz) · max. Hebel
| |  | | |_| | |___| | | |_) | |_| || |     @CAPITAL@ · selbstlernend
|_|  |_|\___/|_____|_| |____/ \___/ |_|     NUR SIMULATION – keine echten Orders
"""


async def _serve(cfg, runner, host: str, port: int, open_mode: str | None) -> None:
    import warnings

    import uvicorn

    from .launcher import lan_ip, open_app
    from .web.server import create_app

    warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"uvicorn\..*")
    app = create_app(cfg, runner)
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", ws="auto"))
    loop = asyncio.get_running_loop()

    def _shutdown(*_):
        runner.stop()
        server.should_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:  # Windows
            signal.signal(sig, lambda *_: _shutdown())
    local_url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"

    async def _announce():
        while not server.started:
            if server.should_exit:
                return
            await asyncio.sleep(0.1)
        log.info("Terminal: %s", local_url)
        if host in ("0.0.0.0", "::"):
            ip = lan_ip()
            if ip:
                log.info("Handy/Tablet im selben WLAN: http://%s:%d", ip, port)
        if open_mode == "app":
            log.info("Geöffnet im %s", open_app(local_url))
        elif open_mode == "browser":
            import webbrowser

            webbrowser.open(local_url)
        log.info("Beenden: dieses Fenster schließen oder Strg+C")

    announcer = asyncio.create_task(_announce())
    bot = asyncio.create_task(runner.run())
    await server.serve()
    announcer.cancel()
    runner.stop()
    try:
        await asyncio.wait_for(bot, timeout=10)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass


def _already_running(port: int) -> bool:
    """True if a MULTBOT terminal already answers on this port (second double-click just opens it)."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1.5) as r:
            return "info" in json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return False


async def _headless(runner) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runner.stop)
        except NotImplementedError:
            pass
    await runner.run()


def cmd_run(args, sim: bool = False) -> None:
    cfg = load_config(args.config)
    cfg._path = args.config
    if args.data_dir:
        cfg.data_dir = args.data_dir
    from .engine.runner import LiveRunner, SimRunner

    host = args.host or ("0.0.0.0" if args.lan else cfg.web.host)
    port = args.port or cfg.web.port
    open_mode = "app" if args.app else "browser" if args.open else None
    if not args.no_web and _already_running(port):
        from .launcher import open_app

        url = f"http://127.0.0.1:{port}"
        print(f"MULTBOT läuft bereits auf {url} – öffne nur das Terminal.")
        if open_mode == "app":
            open_app(url)
        elif open_mode == "browser":
            import webbrowser

            webbrowser.open(url)
        return
    runner = SimRunner(cfg, speed=args.speed, seed=args.seed, markets=args.markets) if sim else LiveRunner(cfg)
    acc = cfg.account
    n_pos = f"max. {cfg.risk.max_open_positions} offen" if cfg.risk.max_open_positions else "gerankt, unbegrenzt"
    capital = (f"{acc.position_margin_usd:g} USD je Position · {n_pos}" if acc.fixed
               else f"Startkapital {acc.starting_balance:g} USD")
    print(BANNER.replace("@CAPITAL@", capital))
    if args.no_web:
        asyncio.run(_headless(runner))
    else:
        asyncio.run(_serve(cfg, runner, host, port, open_mode))


def cmd_shortcut(args) -> None:
    from .launcher import create_shortcut

    extra = " sim" if args.sim else " run"
    path = create_shortcut(args.dir, args.python, args=extra.strip() + " --app" + (" --lan" if args.lan else ""),
                           name="MULTBOT Simulation" if args.sim else "MULTBOT")
    print(f"Verknüpfung erstellt: {path}")
    print("Doppelklick startet den Bot und öffnet das Terminal als eigenes App-Fenster.")


def cmd_research(args) -> None:
    cfg = load_config(args.config)
    if args.data_dir:
        cfg.data_dir = args.data_dir
    if args.entry_mode:
        cfg.execution.entry_mode = args.entry_mode
    from .research.report import print_summary, run_research

    last = [-1]

    def prog(x):
        p = int(x * 20)
        if p != last[0]:
            last[0] = p
            print(f"\rBacktest [{'█' * p}{'·' * (20 - p)}] {x * 100:5.1f}%", end="", flush=True)

    coins = args.coins.split(",") if args.coins else None
    rep = asyncio.run(run_research(cfg, args.interval, args.bars, progress=prog, top=args.top, coins=coins))
    print()
    print_summary(rep)


def cmd_markets(args) -> None:
    cfg = load_config(args.config)
    from .exchange.hyperliquid import HLRest
    from .exchange.meta import build_specs

    async def go():
        rest = HLRest(cfg.api_url)
        try:
            metas, ctxs = {}, {}
            for dex in cfg.dexes:
                metas[dex], ctxs[dex] = await rest.meta_and_ctxs(dex)
        finally:
            await rest.close()
        specs = build_specs(cfg, metas)
        print(f"{'Markt':<11}{'Dex':<5}{'Hebel':>6}{'Mark':>13}{'24h':>9}{'Funding 8h':>12}{'Volumen':>11}"
              f"{'OI':>11}{'Taker':>9}")
        for dex, meta in metas.items():
            for u, c in zip(meta["universe"], ctxs[dex]):
                if u["name"] not in specs:
                    continue
                s = specs[u["name"]]
                mark, prev = float(c["markPx"]), float(c["prevDayPx"] or 0)
                chg = (mark / prev - 1) * 100 if prev else 0.0
                f8 = float(c["funding"]) * 8 * 100
                oi = float(c["openInterest"]) * mark
                print(f"{s.symbol:<11}{(s.dex or 'main'):<5}{s.leverage:>5}x{mark:>13.6g}{chg:>+8.2f}%{f8:>+11.4f}%"
                      f"{float(c['dayNtlVlm']):>11,.0f}{oi:>11,.0f}{s.taker_fee * 100:>8.4f}%")

    asyncio.run(go())


def cmd_report(args) -> None:
    cfg = load_config(args.config)
    if args.data_dir:
        cfg.data_dir = args.data_dir
    from .data.store import Store
    from .research.analytics import trade_metrics

    store = Store(cfg.data_path(f"{args.run}.db"))
    st = store.get_kv(f"engine:{args.run}") or {}
    acc = st.get("account", {})
    trades = store.trades(args.run, 100000)
    tm = trade_metrics(trades)
    print(f"Lauf '{args.run}': Epoche {acc.get('epoch', 1)}, Guthaben {acc.get('balance', 0):.2f} USD, "
          f"offene Positionen {len(acc.get('positions', {}))}")
    if tm.get("n"):
        print(f"Trades {tm['n']}  Netto {tm['net']:+.2f} USD  Treffer {tm['win_rate'] * 100:.1f}%  "
              f"PF {tm['profit_factor']}  Liquidationen {tm['liquidations']}  Gebühren {tm['fees']:.2f}")
        for t in trades[-15:]:
            print(f"  {fmt_ts(t['exit_ms'])} {t['coin']:<10} {'L' if t['side'] > 0 else 'S'} {t['leverage']}x "
                  f"{t['entry_px']:.6g}→{t['exit_px']:.6g} netto {t['net']:+.3f} ({t['reason']})")
    else:
        print("Noch keine abgeschlossenen Trades.")


def _ensure_project_dir(args) -> None:
    """Started from a shortcut or another folder: work inside the project so config.yaml and data/ are found."""
    import os
    from pathlib import Path

    from .launcher import REPO_DIR

    if not Path(args.config).exists() and (REPO_DIR / args.config).exists():
        os.chdir(REPO_DIR)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="multbot", description="MULTBOT – Perpetual Signal Bot (Paper-Trading)")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--data-dir", default=None)
    p.add_argument("--log", default="INFO")
    sub = p.add_subparsers(dest="cmd")

    for name in ("run", "sim"):
        sp = sub.add_parser(name, help="Live-Papierhandel" if name == "run" else "Offline-Simulation")
        sp.add_argument("--host", default=None)
        sp.add_argument("--port", type=int, default=None)
        sp.add_argument("--no-web", action="store_true", help="ohne Dashboard laufen")
        sp.add_argument("--open", action="store_true", help="Terminal im Standardbrowser öffnen")
        sp.add_argument("--app", action="store_true", help="Terminal als eigenes App-Fenster öffnen")
        sp.add_argument("--lan", action="store_true", help="im lokalen Netz erreichbar machen (Handy/Tablet)")
        sp.add_argument("--speed", type=float, default=120.0, help="Sim: Zeitraffer-Faktor")
        sp.add_argument("--seed", type=int, default=None, help="Sim: Zufalls-Seed")
        sp.add_argument("--markets", type=int, default=20, help="Sim: Anzahl synthetischer Märkte")

    sr = sub.add_parser("research", help="Walk-Forward-Backtest + Forschung")
    sr.add_argument("--interval", default=None)
    sr.add_argument("--bars", type=int, default=None)
    sr.add_argument("--entry-mode", choices=["maker", "taker"], default=None)
    sr.add_argument("--top", type=int, default=None, help="nur die N volumenstärksten Märkte (0 = alle)")
    sr.add_argument("--coins", default=None, help="kommagetrennte Märkte, z. B. BTC,ETH,xyz:TSLA")
    sub.add_parser("markets", help="Live-Markttabelle")
    sc = sub.add_parser("shortcut", help="Desktop-Verknüpfung erstellen (startet als App-Fenster)")
    sc.add_argument("--dir", default=None, help="Zielordner (Standard: Desktop)")
    sc.add_argument("--python", default=None, help="Python-Interpreter (Standard: der aktuelle)")
    sc.add_argument("--sim", action="store_true", help="Verknüpfung für die Simulation statt Live")
    sc.add_argument("--lan", action="store_true", help="auch im WLAN erreichbar")
    rp = sub.add_parser("report", help="Kontoübersicht aus der Datenbank")
    rp.add_argument("--run", default="live")

    args = p.parse_args(argv)
    setup_logging(args.log)
    _ensure_project_dir(args)
    if args.cmd == "run":
        cmd_run(args)
    elif args.cmd == "sim":
        cmd_run(args, sim=True)
    elif args.cmd == "research":
        cmd_research(args)
    elif args.cmd == "markets":
        cmd_markets(args)
    elif args.cmd == "shortcut":
        cmd_shortcut(args)
    elif args.cmd == "report":
        cmd_report(args)
    else:
        p.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
