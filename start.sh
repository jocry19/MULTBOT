#!/usr/bin/env bash
# MULT Q2 starten (Linux/macOS).
# Erster Start: nutzt vorhandenes Python 3.10+, sonst wird Python automatisch über "uv"
# (offizielles Tool von Astral, ohne Admin-Rechte) installiert. Danach Pakete installieren,
# Desktop-Icon anlegen und das Terminal als App-Fenster öffnen. Strg+C beendet den Bot.
#   ./start.sh             Live-Papierhandel
#   ./start.sh sim         Offline-Simulation
#   ./start.sh run --lan   zusätzlich im WLAN erreichbar (Handy)
cd "$(dirname "$0")" || exit 1
MODE="${1:-run}"
shift 2>/dev/null || true
VPY=".venv/bin/python"
FIRST=""

find_python() {
  [ -n "$MULTBOT_USE_UV" ] && return 1
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    # macOS: /usr/bin/python3 is only a stub until the Xcode command line tools are installed
    if [ "$(uname)" = "Darwin" ] && [ "$p" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
      continue
    fi
    if "$p" -c 'import sys, venv; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

find_uv() {
  command -v uv 2>/dev/null && return 0
  for p in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

if [ ! -x "$VPY" ]; then
  FIRST=1
  echo "[MULT Q2] Erster Start – richte alles ein (einmalig, ca. 1–3 Minuten) ..."
  if PY="$(find_python)" && "$PY" -m venv .venv 2>/dev/null && [ -x "$VPY" ]; then
    echo "[MULT Q2] Python gefunden: $PY"
  else
    rm -rf .venv
    echo "[MULT Q2] Kein passendes Python – installiere Python automatisch (ohne Admin-Rechte) ..."
    UV="$(find_uv)" || { curl -LsSf https://astral.sh/uv/install.sh | sh; UV="$(find_uv)"; } || {
      echo "[MULT Q2] Python konnte nicht installiert werden – bitte von https://www.python.org/downloads/ installieren."
      exit 1
    }
    "$UV" venv --seed --python 3.12 .venv || exit 1
  fi
fi

echo "[MULT Q2] Prüfe Pakete ..."
"$VPY" -m pip install --disable-pip-version-check -q -r requirements.txt || {
  echo "[MULT Q2] Paketinstallation fehlgeschlagen – Internet prüfen. Neu aufsetzen: Ordner .venv löschen."
  exit 1
}
if [ -n "$FIRST" ]; then "$VPY" -m multbot shortcut || true; fi
exec "$VPY" -m multbot "$MODE" --app "$@"
