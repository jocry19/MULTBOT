#!/usr/bin/env bash
# MULTBOT starten (macOS) – Doppelklick im Finder. Fenster schließen = Bot beenden.
cd "$(dirname "$0")"
exec ./start.sh "$@"
