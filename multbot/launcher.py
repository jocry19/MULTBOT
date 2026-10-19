"""Opening the terminal like a desktop app: browser app windows, desktop shortcuts, LAN address."""
from __future__ import annotations

import logging
import os
import platform
import shutil
import socket
import stat
import subprocess
import sys
import webbrowser
from pathlib import Path

log = logging.getLogger("multbot.launcher")

REPO_DIR = Path(__file__).resolve().parent.parent
ICON_DIR = Path(__file__).resolve().parent / "web" / "static"


def _candidates() -> list[str]:
    system = platform.system()
    if system == "Windows":
        roots = [os.environ.get(k, "") for k in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
        rel = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe",
               r"BraveSoftware\Brave-Browser\Application\brave.exe", r"Chromium\Application\chrome.exe"]
        paths = [str(Path(root) / r) for root in roots if root for r in rel]
        return paths + [p for p in (shutil.which("msedge"), shutil.which("chrome")) if p]
    if system == "Darwin":
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge",
             "brave-browser"]
    return [p for p in (shutil.which(n) for n in names) if p]


def find_app_browser() -> str | None:
    """A Chromium-based browser that supports ``--app=URL`` (window without tabs/address bar)."""
    for path in _candidates():
        if path and Path(path).exists():
            return path
    return None


def open_app(url: str) -> str:
    """Open the terminal in an app window; falls back to the default browser. Returns what was used."""
    browser = find_app_browser()
    if browser:
        try:
            kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
            if platform.system() == "Windows":
                kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0)
            else:
                kwargs["start_new_session"] = True
            subprocess.Popen([browser, f"--app={url}", "--window-size=1600,1000"], **kwargs)
            return f"App-Fenster ({Path(browser).stem})"
        except OSError as e:
            log.warning("App-Fenster konnte nicht geöffnet werden (%s) – nutze Standardbrowser", e)
    webbrowser.open(url)
    return "Standardbrowser"


def lan_ip() -> str | None:
    """Best-effort local network address (for opening the terminal on a phone in the same WLAN)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        s.close()


def desktop_dir() -> Path:
    home = Path.home()
    for name in ("Desktop", "Schreibtisch"):
        if (home / name).is_dir():
            return home / name
    if platform.system() == "Windows":
        onedrive = os.environ.get("OneDrive")
        if onedrive and (Path(onedrive) / "Desktop").is_dir():
            return Path(onedrive) / "Desktop"
    return home


def create_shortcut(target_dir: Path | None = None, python: str | None = None, args: str = "run --app",
                    name: str = "MULT Q2") -> Path:
    """Create a desktop shortcut that starts the bot and opens the terminal as an app window."""
    target_dir = Path(target_dir) if target_dir else desktop_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    python = python or sys.executable
    system = platform.system()
    if system == "Windows":
        path = target_dir / f"{name}.lnk"
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
            "$s.TargetPath='{py}';$s.Arguments='-m multbot {args}';$s.WorkingDirectory='{wd}';"
            "$s.IconLocation='{ico}';$s.Description='MULT Q2 Perp Signal Terminal';$s.Save()"
        ).format(lnk=str(path).replace("'", "''"), py=python.replace("'", "''"), args=args,
                 wd=str(REPO_DIR).replace("'", "''"), ico=str(ICON_DIR / "favicon.ico").replace("'", "''"))
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], check=True)
        return path
    if system == "Darwin":
        path = target_dir / f"{name}.command"
        path.write_text(f'#!/bin/bash\ncd "{REPO_DIR}"\n"{python}" -m multbot {args}\n', encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return path
    path = target_dir / f"{name.lower().replace(' ', '-')}.desktop"
    path.write_text(
        f"[Desktop Entry]\nType=Application\nName={name}\nComment=Perp Signal Terminal (Paper-Trading)\n"
        f'Exec=sh -c \'cd "{REPO_DIR}" && "{python}" -m multbot {args}\'\n'
        f"Icon={ICON_DIR / 'icon-512.png'}\nTerminal=true\nCategories=Finance;Office;\n",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    apps = Path.home() / ".local" / "share" / "applications"
    if target_dir != apps:
        try:
            apps.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, apps / path.name)
        except OSError:
            pass
    return path
