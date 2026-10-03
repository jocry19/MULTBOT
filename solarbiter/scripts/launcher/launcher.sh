#!/usr/bin/env bash
# SOLARBITER launcher for macOS and Linux — called by the double-click files in the project folder.
#
#   launcher.sh start     start (first run: setup), wait until ready, open the dashboard
#   launcher.sh stop      stop all containers (data is kept)
#   launcher.sh desktop   Linux: add "SOLARBITER starten/stoppen" to the application menu
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

pause_close() {
  echo
  if [ -t 0 ]; then read -r -p "Enter drücken, um das Fenster zu schließen … " _ || true; fi
}
fail() {
  printf '\nFEHLER: %s\n' "$*" >&2
  pause_close
  exit 1
}
info() { printf '\n==> %s\n' "$*"; }

open_url() {
  case "$OS" in
    Darwin) open "$1" >/dev/null 2>&1 ;;
    *) command -v xdg-open >/dev/null 2>&1 && { xdg-open "$1" >/dev/null 2>&1 & } ;;
  esac
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

  info "Starte SOLARBITER (beim ersten Mal wird das Programm gebaut — das dauert einige Minuten) …"
  if ! docker compose up -d --build --remove-orphans; then
    echo
    docker compose logs --tail 40 migrate api worker 2>/dev/null || true
    fail "Start fehlgeschlagen (Details oben)."
  fi

  local port base waited=0
  port="$(env_get HTTP_PORT)"
  base="http://127.0.0.1:${port:-8788}"
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
  open_url "$base"
  echo
  echo "Der Bot läuft im Hintergrund weiter (Paper-Modus), auch wenn du dieses Fenster schließt."
  echo "Beenden: Doppelklick auf »SOLARBITER stoppen«. Echtgeld bleibt gesperrt, bis du es"
  echo "nach erfolgreicher Validierung im Dashboard selbst freigibst."
  pause_close
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
Icon=utilities-terminal
Categories=Office;Finance;
EOF
    chmod 755 "$dir/solarbiter-$action.desktop"
  done
  echo "Im Anwendungsmenü: »SOLARBITER starten« und »SOLARBITER stoppen« ($dir)."
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  desktop) cmd_desktop ;;
  *) echo "usage: launcher.sh start|stop|desktop" >&2; exit 2 ;;
esac
