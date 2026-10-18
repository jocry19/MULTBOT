#!/usr/bin/env bash
# MULTBOT starten (Linux/macOS). Erster Start legt .venv an und installiert alles,
# danach öffnet sich das Terminal als App-Fenster. Strg+C beendet den Bot.
#   ./start.sh          Live-Papierhandel
#   ./start.sh sim      Offline-Simulation
#   ./start.sh run --lan   zusätzlich im WLAN erreichbar (Handy)
set -e
cd "$(dirname "$0")"
MODE="${1:-run}"
shift || true
if [ ! -x ".venv/bin/python" ]; then
  PY="$(command -v python3 || command -v python || true)"
  if [ -z "$PY" ]; then
    echo "[MULTBOT] Python 3.10+ nicht gefunden – bitte installieren: https://www.python.org/downloads/"
    exit 1
  fi
  echo "[MULTBOT] Erstinstallation: lege Python-Umgebung an ..."
  "$PY" -m venv .venv
fi
echo "[MULTBOT] Prüfe Pakete ..."
.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
exec .venv/bin/python -m multbot "$MODE" --app "$@"
