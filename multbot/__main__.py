"""Command line interface.

    python -m multbot run          # live paper trading on Hyperliquid data + terminal dashboard
    python -m multbot sim          # offline simulation with a synthetic market (accelerated)
    python -m multbot research     # walk-forward backtest, Monte Carlo, signal research
    python -m multbot markets      # live market table for the configured assets
    python -m multbot report       # account summary from the database
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
| |  | | |_| | |___| | | |_) | |_| || |     Startkapital 100 USD · selbstlernend
|_|  |_|\___/|_____|_| |____/ \___/ |_|     NUR SIMULATION – keine echten Orders
"""


async def _serve(cfg, runner, host: str, port: int, open_browser: bool) -> None:
    import warnings

    import uvicorn

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
    url = f"http://{host}:{port}"
    log.info("Terminal: %s", url)
    if open_browser:
        import webbrowser

        loop.call_later(1.5, webbrowser.open, url)
    bot = asyncio.create_task(runner.run())
    await server.serve()
    runner.stop()
    try:
        await asyncio.wait_for(bot, timeout=10)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass


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

    runner = SimRunner(cfg, speed=args.speed, seed=args.seed) if sim else LiveRunner(cfg)
    print(BANNER)
    host = args.host or cfg.web.host
    port = args.port or cfg.web.port
    if args.no_web:
        asyncio.run(_headless(runner))
    else:
        asyncio.run(_serve(cfg, runner, host, port, args.open))


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

    rep = asyncio.run(run_research(cfg, args.interval, args.bars, progress=prog))
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
        sp.add_argument("--open", action="store_true", help="Browser öffnen")
        sp.add_argument("--speed", type=float, default=120.0, help="Sim: Zeitraffer-Faktor")
        sp.add_argument("--seed", type=int, default=None, help="Sim: Zufalls-Seed")

    sr = sub.add_parser("research", help="Walk-Forward-Backtest + Forschung")
    sr.add_argument("--interval", default=None)
    sr.add_argument("--bars", type=int, default=None)
    sr.add_argument("--entry-mode", choices=["maker", "taker"], default=None)
    sub.add_parser("markets", help="Live-Markttabelle")
    rp = sub.add_parser("report", help="Kontoübersicht aus der Datenbank")
    rp.add_argument("--run", default="live")

    args = p.parse_args(argv)
    setup_logging(args.log)
    if args.cmd == "run":
        cmd_run(args)
    elif args.cmd == "sim":
        cmd_run(args, sim=True)
    elif args.cmd == "research":
        cmd_research(args)
    elif args.cmd == "markets":
        cmd_markets(args)
    elif args.cmd == "report":
        cmd_report(args)
    else:
        p.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
