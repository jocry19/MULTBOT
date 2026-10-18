import json
import platform
from pathlib import Path

import pytest

from multbot import launcher
from multbot.__main__ import _already_running


def test_lan_ip_does_not_crash():
    ip = launcher.lan_ip()
    assert ip is None or ip.count(".") == 3


def test_not_running_on_free_port():
    assert _already_running(1) is False


@pytest.mark.skipif(platform.system() == "Windows", reason="Windows creates a .lnk via PowerShell")
def test_create_shortcut(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    path = launcher.create_shortcut(tmp_path / "desk", python="/usr/bin/python3")
    text = path.read_text()
    assert "-m multbot run --app" in text
    assert str(launcher.REPO_DIR) in text
    assert path.stat().st_mode & 0o111


def test_pwa_assets_present():
    static = Path(launcher.ICON_DIR)
    manifest = json.loads((static / "manifest.webmanifest").read_text())
    assert manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        assert (static / Path(icon["src"]).name).exists()
    for name in ("sw.js", "favicon.ico", "apple-touch-icon.png"):
        assert (static / name).exists()
