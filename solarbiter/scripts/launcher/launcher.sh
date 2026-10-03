#!/usr/bin/env bash
# SOLARBITER launcher for macOS and Linux — called by the double-click files in the project folder.
#
#   launcher.sh start     start (first run: setup), wait until ready, open the dashboard window
#   launcher.sh stop      stop all containers (data is kept)
#   launcher.sh app       start without a terminal (used by the SOLARBITER app icon); opens a
#                         terminal only when something has to be entered
#   launcher.sh shortcut  create the SOLARBITER icon again (macOS: Desktop app, Linux: app menu)
#   launcher.sh desktop   Linux: same as shortcut
#
# The first successful start creates the icon automatically. The dashboard opens as its own app
# window (Chrome/Edge/Brave/Chromium in app mode) or, without one of those, in the default browser.
#
# Everything runs in Docker (PostgreSQL, Redis, worker, API + dashboard). Secrets are written only
# to .env (chmod 600, git-ignored); the dashboard password is passed via stdin, never as an argument.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
# Docker Desktop's CLI is not always on the PATH of a double-clicked script.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"

DOCKER_URL="https://www.docker.com/products/docker-desktop/"
OS="$(uname -s)"
GUI=0        # 1 = started from the app icon: no terminal, errors as a dialog
FIRST_RUN=0  # 1 = .env was created in this run

pause_close() {
  echo
  if [ -t 0 ]; then read -r -p "Enter drücken, um das Fenster zu schließen … " _ || true; fi
}
gui_alert() {
  if [ "$OS" = Darwin ]; then
    osascript -e 'on run argv' -e 'display alert "SOLARBITER" message (item 1 of argv) as critical' -e 'end run' "$1" >/dev/null 2>&1 && return
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --title=SOLARBITER --text="$1" >/dev/null 2>&1 && return
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send SOLARBITER "$1" >/dev/null 2>&1 && return
  fi
  printf 'FEHLER: %s\n' "$1" >&2
}
fail() {
  if [ "$GUI" = 1 ]; then
    gui_alert "$* Details: $ROOT/logs/launcher.log — oder »SOLARBITER starten« im Ordner $ROOT doppelklicken."
    exit 1
  fi
  printf '\nFEHLER: %s\n' "$*" >&2
  pause_close
  exit 1
}
info() { printf '\n==> %s\n' "$*"; }
notify() {
  [ "$OS" = Darwin ] && osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "SOLARBITER"' -e 'end run' "$1" >/dev/null 2>&1
  return 0
}

open_url() {
  case "$OS" in
    Darwin) open "$1" >/dev/null 2>&1 ;;
    *) command -v xdg-open >/dev/null 2>&1 && { nohup xdg-open "$1" >/dev/null 2>&1 & } ;;
  esac
}

# Dashboard as its own window: a Chromium-based browser in app mode (no tabs, no address bar).
open_app_window() {
  local url="$1" app bin
  if [ "$OS" = Darwin ]; then
    for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
      if open -Ra "$app" >/dev/null 2>&1; then
        open -na "$app" --args --app="$url" >/dev/null 2>&1 && return 0
      fi
    done
  else
    for bin in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable brave-browser; do
      if command -v "$bin" >/dev/null 2>&1; then
        nohup "$bin" --app="$url" >/dev/null 2>&1 &
        return 0
      fi
    done
  fi
  open_url "$url"
}

# --- .env helpers (values are taken literally; no shell or sed interpretation) -------------------
env_get() {
  [ -f .env ] || return 0
  K="$1" awk 'BEGIN { k = ENVIRON["K"] "=" } index($0, k) == 1 { v = substr($0, length(k) + 1) } END { if (v != "") print v }' .env
}
env_set() {
  local content
  content="$(K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 || index($0, "# " k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }' .env)" || fail ".env konnte nicht gelesen werden"
  printf '%s\n' "$content" >.env
}
rand_hex() { LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$1"; }

http_ok() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 3 -o /dev/null "$1" 2>/dev/null
  else wget -q -T 3 -O /dev/null "$1" 2>/dev/null; fi
}
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 "$1" 2>/dev/null
  else wget -q -T 5 -O - "$1" 2>/dev/null; fi
}

# --- Docker ---------------------------------------------------------------------------------------
docker_running() { docker info >/dev/null 2>&1; }
base_url() { local port; port="$(env_get HTTP_PORT)"; echo "http://127.0.0.1:${port:-8788}"; }

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker ist nicht installiert. SOLARBITER braucht Docker Desktop (kostenlos):"
    echo "  $DOCKER_URL"
    open_url "$DOCKER_URL"
    fail "Bitte Docker Desktop installieren, einmal starten und dann erneut doppelklicken."
  fi
  docker compose version >/dev/null 2>&1 || fail "'docker compose' fehlt — bitte Docker Desktop aktualisieren."
  docker_running && return 0

  info "Docker läuft nicht — starte Docker …"
  case "$OS" in
    Darwin) open -a Docker >/dev/null 2>&1 || true ;;
    *) systemctl --user start docker-desktop >/dev/null 2>&1 || true ;;
  esac
  local waited=0
  until docker_running; do
    if [ "$waited" -ge 180 ]; then
      [ "$OS" = Darwin ] || echo "Unter Linux z. B.: sudo systemctl start docker"
      fail "Docker ist nach 3 Minuten nicht bereit. Bitte Docker Desktop starten und erneut doppelklicken."
    fi
    printf '.'
    sleep 3
    waited=$((waited + 3))
  done
  echo " bereit."
}

# --- first run: .env ------------------------------------------------------------------------------
first_run_setup() {
  [ -f .env ] && return 0
  if docker volume inspect solarbiter_pgdata >/dev/null 2>&1; then
    echo "Es gibt bereits eine SOLARBITER-Datenbank, aber keine .env-Datei mehr (darin steht ihr Passwort)."
    echo "Entweder die alte .env wieder in diesen Ordner legen, oder die Datenbank löschen mit:"
    echo "  docker volume rm solarbiter_pgdata"
    fail "Ersteinrichtung abgebrochen."
  fi
  info "Ersteinrichtung"
  FIRST_RUN=1
  (umask 077 && cp .env.example .env) || fail ".env konnte nicht angelegt werden"
  chmod 600 .env
  env_set POSTGRES_PASSWORD "$(rand_hex 40)"

  echo
  echo "Solana-RPC: Empfohlen ist ein eigener Zugang, z. B. Helius:"
  echo "  https://mainnet.helius-rpc.com/?api-key=DEIN_KEY"
  echo "Leer lassen = öffentlicher RPC (langsam und stark limitiert)."
  local rpc=""
  while :; do
    read -r -p "RPC-URL: " rpc || rpc=""
    rpc="${rpc//[[:space:]]/}"
    [ -z "$rpc" ] && break
    case "$rpc" in https://*) break ;; *) echo "Die URL muss mit https:// beginnen." ;; esac
  done
  if [ -n "$rpc" ]; then
    env_set SOLANA_RPC_URL "$rpc"
    env_set SOLANA_RPC_FALLBACK_URLS "https://api.mainnet-beta.solana.com"
  fi

  echo
  echo "Jupiter-API-Key (optional, kostenlos unter https://developers.jup.ag) — verdoppelt das Quote-Budget."
  local jup=""
  read -r -p "Jupiter-Key (leer = ohne): " jup || jup=""
  jup="${jup//[[:space:]]/}"
  if [ -n "$jup" ]; then
    env_set JUPITER_API_KEY "$jup"
    env_set JUPITER_RPS "1"
  fi
  echo
  echo "Gespeichert in $ROOT/.env (nur für dich lesbar, nie in Git)."
}

# --- first run: dashboard user -------------------------------------------------------------------
create_user_if_needed() {
  local base="$1" status
  status="$(http_get "$base/api/auth/status")" || return 0
  case "$status" in *'"setupRequired":true'*) ;; *) return 0 ;; esac

  info "Dashboard-Zugang anlegen"
  local user pw pw2
  while :; do
    read -r -p "Benutzername [admin]: " user || user=""
    user="${user:-admin}"
    [[ "$user" =~ ^[A-Za-z0-9_.-]{3,50}$ ]] && break
    echo "3–50 Zeichen: Buchstaben, Ziffern, _ . -"
  done
  while :; do
    read -r -s -p "Passwort (mind. 12 Zeichen, Eingabe unsichtbar): " pw || pw=""
    echo
    if [ "${#pw}" -lt 12 ]; then echo "Zu kurz."; continue; fi
    read -r -s -p "Passwort wiederholen: " pw2 || pw2=""
    echo
    [ "$pw" = "$pw2" ] && break
    echo "Die Passwörter stimmen nicht überein."
  done
  printf '%s\n' "$pw" | docker compose exec -T api node apps/api/dist/cli/user.js "$user" ||
    fail "Benutzer konnte nicht angelegt werden."
  pw="" pw2=""
}

# --- commands -------------------------------------------------------------------------------------
cmd_start() {
  echo "SOLARBITER — Start"
  ensure_docker
  first_run_setup
  mkdir -p secrets && chmod 700 secrets

  local base waited=0
  base="$(base_url)"
  if http_ok "$base/api/health"; then
    # already running: never restart a running bot just to open the window
    info "SOLARBITER läuft bereits."
  else
    info "Starte SOLARBITER (beim ersten Mal wird das Programm gebaut — das dauert einige Minuten) …"
    if ! docker compose up -d --build --remove-orphans; then
      echo
      docker compose logs --tail 40 migrate api worker 2>/dev/null || true
      fail "Start fehlgeschlagen (Details oben)."
    fi
  fi

  info "Warte auf das Dashboard …"
  until http_ok "$base/api/health"; do
    if [ "$waited" -ge 180 ]; then
      docker compose logs --tail 40 api 2>/dev/null || true
      fail "Das Dashboard antwortet nicht unter $base."
    fi
    sleep 2
    waited=$((waited + 2))
  done

  create_user_if_needed "$base"

  info "SOLARBITER läuft: $base"
  docker compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
  if [ "$FIRST_RUN" = 1 ]; then cmd_shortcut || true; fi
  open_app_window "$base"
  echo
  echo "Der Bot läuft im Hintergrund weiter (Paper-Modus), auch wenn du dieses Fenster schließt."
  echo "Beenden: Doppelklick auf »SOLARBITER stoppen«. Echtgeld bleibt gesperrt, bis du es"
  echo "nach erfolgreicher Validierung im Dashboard selbst freigibst."
  [ -t 1 ] && sleep 4
  return 0
}

# Started from the app icon: no terminal. Anything that needs input opens the interactive start.
open_interactive_start() {
  if [ "$OS" = Darwin ]; then
    open -a Terminal "$ROOT/SOLARBITER starten.command" >/dev/null 2>&1 && exit 0
  else
    local t
    for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
      command -v "$t" >/dev/null 2>&1 || continue
      if [ "$t" = gnome-terminal ]; then nohup "$t" -- bash "$ROOT/scripts/launcher/launcher.sh" start >/dev/null 2>&1 &
      else nohup "$t" -e bash "$ROOT/scripts/launcher/launcher.sh" start >/dev/null 2>&1 &
      fi
      exit 0
    done
  fi
  fail "Für die Einrichtung bitte »SOLARBITER starten« im Ordner $ROOT doppelklicken."
}

cmd_app() {
  GUI=1
  mkdir -p logs
  exec >>logs/launcher.log 2>&1
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') app start"
  [ -f .env ] || open_interactive_start
  local base waited=0
  base="$(base_url)"
  if ! http_ok "$base/api/health"; then
    notify "SOLARBITER startet …"
    ensure_docker
    mkdir -p secrets && chmod 700 secrets
    docker compose up -d --build --remove-orphans || fail "Start fehlgeschlagen."
  fi
  until http_ok "$base/api/health"; do
    [ "$waited" -ge 180 ] && fail "Das Dashboard antwortet nicht unter $base."
    sleep 2
    waited=$((waited + 2))
  done
  case "$(http_get "$base/api/auth/status")" in *'"setupRequired":true'*) open_interactive_start ;; esac
  open_app_window "$base"
}

cmd_stop() {
  echo "SOLARBITER — Stopp"
  if ! command -v docker >/dev/null 2>&1 || ! docker_running; then
    echo "Docker läuft nicht — SOLARBITER ist bereits gestoppt."
    pause_close
    return 0
  fi
  docker compose down || fail "Stoppen fehlgeschlagen."
  echo
  echo "SOLARBITER ist gestoppt. Alle Daten (Datenbank, Einstellungen, Trades) bleiben erhalten."
  pause_close
}

# macOS: a small SOLARBITER.app on the Desktop that runs `launcher.sh app`. It is created locally,
# so Gatekeeper does not quarantine it; it can be dragged into the Dock.
make_mac_app() {
  local app="${SOLARBITER_APP_DIR:-$HOME/Desktop}/SOLARBITER.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" || fail "$app konnte nicht angelegt werden"
  cp "$ROOT/scripts/launcher/assets/solarbiter.icns" "$app/Contents/Resources/solarbiter.icns" || fail "Icon fehlt"
  cat >"$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SOLARBITER</string>
  <key>CFBundleDisplayName</key><string>SOLARBITER</string>
  <key>CFBundleIdentifier</key><string>local.solarbiter.launcher</string>
  <key>CFBundleExecutable</key><string>SOLARBITER</string>
  <key>CFBundleIconFile</key><string>solarbiter</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
  {
    echo '#!/bin/bash'
    echo '# SOLARBITER app: starts the Docker stack and opens the dashboard window (no terminal).'
    printf 'exec /bin/bash %q app\n' "$ROOT/scripts/launcher/launcher.sh"
  } >"$app/Contents/MacOS/SOLARBITER"
  chmod 755 "$app/Contents/MacOS/SOLARBITER"
  touch "$app"
  echo "App-Icon angelegt: $app (zum Starten doppelklicken; lässt sich ins Dock ziehen)."
}

cmd_shortcut() {
  case "$OS" in
    Darwin) make_mac_app ;;
    Linux) cmd_desktop ;;
    *) echo "Kein Icon für $OS." ;;
  esac
}

cmd_desktop() {
  [ "$OS" = Linux ] || fail "Nur für Linux — unter macOS die .command-Dateien doppelklicken."
  case "$ROOT" in
    *[\"\`\$%\\]*) fail "Der Ordnerpfad enthält Sonderzeichen (\" \` \$ % \\) — bitte SOLARBITER in einen anderen Ordner legen." ;;
  esac
  local dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications" script="\"$ROOT/scripts/launcher/launcher.sh\""
  mkdir -p "$dir" || fail "$dir konnte nicht angelegt werden"
  local action name
  for action in start stop; do
    if [ "$action" = start ]; then name="SOLARBITER starten"; else name="SOLARBITER stoppen"; fi
    cat >"$dir/solarbiter-$action.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Comment=SOLARBITER Solana-Arbitrage-Bot ($action)
Exec=bash $script $action
Terminal=true
Icon=$ROOT/scripts/launcher/assets/solarbiter.png
Categories=Office;Finance;
EOF
    chmod 755 "$dir/solarbiter-$action.desktop"
  done
  echo "Im Anwendungsmenü: »SOLARBITER starten« und »SOLARBITER stoppen« ($dir)."
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  app) cmd_app ;;
  shortcut) cmd_shortcut ;;
  desktop) cmd_desktop ;;
  *) echo "usage: launcher.sh start|stop|app|shortcut|desktop" >&2; exit 2 ;;
esac
