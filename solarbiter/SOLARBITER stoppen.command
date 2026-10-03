#!/bin/bash
# Doppelklick (macOS): stoppt SOLARBITER. Datenbank, Einstellungen und Trades bleiben erhalten.
exec /bin/bash "$(cd "$(dirname "$0")" && pwd)/scripts/launcher/launcher.sh" stop
