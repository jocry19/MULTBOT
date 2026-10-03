#!/bin/bash
# Doppelklick (macOS): startet SOLARBITER in Docker und öffnet das Dashboard im Browser.
# Linux: im Terminal ausführen oder einmal `bash scripts/launcher/launcher.sh desktop` für das Anwendungsmenü.
exec /bin/bash "$(cd "$(dirname "$0")" && pwd)/scripts/launcher/launcher.sh" start
