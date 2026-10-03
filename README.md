# MULTBOT — Solana Memecoin Research-, Learning- & Trading-System

MULTBOT beobachtet den Pump.fun-/PumpSwap-Markt auf Solana in Echtzeit, sammelt eigene Marktdaten,
sucht darin **statistisch belastbare** Muster, prüft sie mit Backtests und Paper Trading unter
realistischen Kosten und stellt die Ergebnisse in einem Trading-Terminal dar. Echtgeld-Handel ist
möglich, wird aber **ausschließlich durch eine manuelle Aktion** freigeschaltet.

> **Wichtig:** Keine Strategie ist garantiert profitabel. Memecoins können in Sekunden wertlos
> werden. Alle Kennzahlen sind Schätzungen auf Basis vergangener Daten. Der Bot behauptet nie, eine
> Strategie sei sicher profitabel, und schaltet Echtgeld nie selbstständig ein. Die Steuer-Exporte
> sind Dokumentation, **keine Steuerberatung**.

> **Zweites Projekt in diesem Repository:** [`solarbiter/`](solarbiter/README.md) — SOLARBITER, ein
> Solana-Multi-DEX-Arbitrage-Bot (Jupiter, Raydium, Orca, Meteora) mit eigenem Workspace,
> eigener Datenbank und eigener Dokumentation.

---

## Inhalt

1. [Was das System macht](#was-das-system-macht)
2. [Schnellstart mit Docker](#schnellstart-mit-docker)
3. [Einrichtung Schritt für Schritt](#einrichtung-schritt-für-schritt)
4. [Lokale Entwicklung](#lokale-entwicklung)
5. [Lebenszyklus einer Strategie](#lebenszyklus-einer-strategie)
6. [Echtgeld: Freischaltung und Schutzmechanismen](#echtgeld-freischaltung-und-schutzmechanismen)
7. [Sicherheit des privaten Schlüssels](#sicherheit-des-privaten-schlüssels)
8. [Betrieb: Backups, Updates, Monitoring](#betrieb-backups-updates-monitoring)
9. [Projektstruktur und Dokumentation](#projektstruktur-und-dokumentation)
10. [Tests](#tests)
11. [Fehlerbehebung](#fehlerbehebung)

---

## Was das System macht

| Bereich | Umsetzung |
| --- | --- |
| **Datenaufnahme** | Live-Logs der Pump.fun- und PumpSwap-Programme per WebSocket (Helius oder beliebiger RPC), eigener Anchor-Event-Decoder, verifiziert gegen Mainnet-Transaktionen. Nur SOL-notierte Märkte werden als SOL-Märkte behandelt. |
| **Marktzustand** | Bonding-Curve- und Pool-Zustand je Token, Trade-Tape, Minuten-Kerzen, Holder, Creator- und Wallet-Verhalten. |
| **Features & Events** | ~170 Merkmale je Entscheidungszeitpunkt, kontextuelle Anomalien (relativ zu Tokens gleichen Alters/Venue), 23 Ereignis-Detektoren, Marktregime. Jeder Datensatz hat `ts` und `available_at` — Backtests sind strikt kausal. |
| **Research** | Research-Samples mit realistischen Ergebnissen (Verzögerung, Slippage aus dem Curve-/Pool-Zustand, Gebühren, Priority Fees, Rent, fehlgeschlagene Transaktionen, MEV-Aufschlag) über 7 Horizonte und ein TP/SL-Raster. |
| **Discovery** | Sucht selbstständig Kombinationen von Bedingungen („Rezepte“), testet Tausende Hypothesen, korrigiert für multiples Testen (Benjamini–Hochberg), Deflated Sharpe, Walk-Forward, unberührter Holdout, Anti-Blindness-Report („Warum könnte diese Strategie NICHT funktionieren?“). |
| **Backtests** | Kausal, kostenbewusst, auf gespeicherten Marktdaten. |
| **Paper Trading** | Echte Live-Daten, simulierte Ausführung, vollständig getrennt vom Echtgeld. Strategie-Wettbewerb je Version. |
| **Lernen & Evolution** | Learning Engine (Entscheidungs- vs. Ergebnisqualität, Kalibrierung der Erwartungen), Decay-Monitor (DEGRADED nur bei statistisch signifikanter Verschlechterung), Strategie-Evolution mit Herausforderer-Versionen (1.1, 2.0 …). |
| **Live Trading** | Jupiter-Ausführung mit Integritätsprüfungen vor jeder Signatur, idempotente Orders, Bestätigungsüberwachung, Reconciliation, unveränderliches Hash-Ledger, deutsche Steuer-Dokumentation (FIFO, CSV/JSON/Excel). |
| **Dashboard** | Dunkles Trading-Terminal mit 17 Bereichen, Live-Updates per WebSocket, Emergency Stop. |

---

## Schnellstart mit Docker

Voraussetzungen: Docker mit Compose-Plugin.

```bash
git clone <repo> multbot && cd multbot
cp .env.example .env
# .env bearbeiten: POSTGRES_PASSWORD, HELIUS_API_KEY, ADMIN_PASSWORD_HASH (siehe unten)
mkdir -p secrets && chmod 700 secrets
docker compose up -d --build
```

Dashboard: <http://127.0.0.1:8787> (nur lokal erreichbar). Ohne Wallet läuft alles außer Echtgeld:
Datenaufnahme, Research, Discovery, Backtests und Paper Trading.

Logs: `docker compose logs -f multbot` · Stoppen: `docker compose down` (Daten bleiben im Volume).

---

## Einrichtung Schritt für Schritt

### 1. Helius-API-Key

1. Konto auf <https://dashboard.helius.dev> anlegen und einen API-Key erzeugen.
2. In `.env` eintragen: `HELIUS_API_KEY=…`

Ohne Key nutzt MULTBOT den öffentlichen Solana-Endpoint (stark limitiert, nur zum Ausprobieren).
Weitere Endpoints als Fallback: `SOLANA_RPC_URLS` / `SOLANA_WS_URLS`. Der RPC-Manager überwacht
Latenz, Slot-Abstand und Fehlerrate und wechselt automatisch.

### 2. Admin-Passwort

```bash
# lokal
echo -n 'ein langes, zufälliges Passwort' | pnpm auth:hash-password
# oder mit Docker
docker compose build
echo -n 'ein langes, zufälliges Passwort' | docker compose run --rm -T cli dist/cli/hash-password.js
```

Den ausgegebenen Wert (`scrypt$…`) als `ADMIN_PASSWORD_HASH` in `.env` eintragen. Ohne Passwort ist
das Dashboard nur lokal nutzbar und **alle Echtgeld-Funktionen sind gesperrt**.

### 3. Bot-Wallet anlegen (optional, nur für Echtgeld)

Die Bot-Wallet ist eine eigene Wallet nur für den Bot — **niemals deine Haupt-Wallet**.

```bash
# Passphrase-Datei anlegen (mind. 12 Zeichen), nur für dich lesbar
printf '%s' 'eine lange Passphrase' > secrets/wallet-passphrase.txt
chmod 600 secrets/wallet-passphrase.txt

# neue Wallet erzeugen – der private Schlüssel wird NICHT angezeigt
pnpm wallet:create
# oder mit Docker (Werkzeug-Container ohne Netzwerkzugang)
docker compose run --rm cli dist/cli/wallet.js create

# Adresse anzeigen
pnpm wallet:address          # bzw. docker compose run --rm cli dist/cli/wallet.js address
```

Eine bestehende Wallet importieren (Schlüssel wird über stdin gelesen, nicht über Argumente):
`pnpm wallet:import` und den Schlüssel (base58 oder JSON-Array) einfügen, dann Strg-D.

Mit Docker muss der Keystore für die Container-Benutzer-ID lesbar sein
(`MULTBOT_UID`, Standard 1000): `sudo chown -R 1000:1000 secrets && chmod 600 secrets/*`.
MULTBOT verweigert Keystores, die für Gruppe/Andere lesbar sind.

Danach neu starten (`docker compose restart multbot`). Im Dashboard unter **Wallet** erscheinen
Adresse, QR-Code zum Einzahlen und Kontostand.

### 4. Wallet befüllen

SOL an die angezeigte Adresse senden (nur Solana Mainnet). Standard-Einstellungen: 0,01 SOL pro
Trade, max. 10 offene Positionen, 0,03 SOL Reserve für Gebühren und Notfall-Exits. Alles ist unter
**Settings** änderbar.

### 5. Erster Start: was passiert?

1. Migrationen laufen automatisch, die Datenaufnahme startet (einige Tausend Events pro Minute).
2. Research-Samples werden gesammelt und nach Ablauf der Horizonte (bis 1 h) mit Ergebnissen versehen.
3. Die Discovery läuft alle 6 Stunden (oder manuell unter **Research**). Mit wenigen Stunden Daten
   überlebt typischerweise **keine** Hypothese die statistischen Prüfungen — das ist gewollt.
4. Gefundene Strategien durchlaufen Backtest → Paper Trading → Validierung.

---

## Lokale Entwicklung

Voraussetzungen: Node.js ≥ 22, pnpm 10 (`corepack enable`), PostgreSQL ≥ 15.

```bash
pnpm install
createdb multbot                      # bzw. Datenbank/Benutzer laut DATABASE_URL anlegen
cp .env.example .env                  # NODE_ENV=development setzen
pnpm dev:server                       # API + Worker auf 127.0.0.1:8787 (Migrationen automatisch)
pnpm dev:web                          # Dashboard auf http://127.0.0.1:5173 (Proxy zur API)
```

Produktions-Build ohne Docker: `pnpm build`, dann `node apps/server/dist/main.js` mit
`WEB_DIST_DIR=apps/web/dist`. Für den Dauerbetrieb liegt eine systemd-Unit unter
`deploy/systemd/multbot.service` (Neustart bei Absturz, Sandboxing).

---

## Lebenszyklus einer Strategie

```
DISCOVERED → TESTING → (Backtest) → PAPER_TRADING → PAPER_VALIDATED → LIVE_ENABLED
                  ↘ REJECTED            ↘ REJECTED        ↘ DEGRADED ↔ PAPER_VALIDATED
```

- **DISCOVERED/TESTING:** von der Discovery gefunden; ein kausaler Backtest nach Kosten entscheidet.
- **PAPER_TRADING:** handelt virtuell mit echten Live-Daten.
- **PAPER_VALIDATED:** Kriterien erfüllt (Anzahl Trades, Profit Factor, Konfidenz, Drawdown —
  unter Settings → Research einstellbar). Das ist eine **Empfehlung zur Prüfung**, keine Freigabe.
- **LIVE_ENABLED:** nur durch dich, pro Strategie, mit der Bestätigung `ENABLE REAL TRADING`.
- **DEGRADED:** das rollierende Ergebnis ist statistisch signifikant schlechter als zuvor. Live-
  Einstiege stoppen; Paper läuft weiter. Wenige Verluste allein führen nicht zu DEGRADED.
- **Evolution:** Für aktive Strategien sucht das System regelmäßig eine bessere Variante (Exit,
  Schwellen, Regime-Filter, Vereinfachung). Sie läuft als **Herausforderer-Version** (z. B. 1.1 oder
  2.0) parallel im Paper Trading. Ist sie klar besser, ersetzt sie die aktuelle Version — außer bei
  Echtgeld-Strategien: dort wird sie nur **empfohlen**, und du entscheidest.

---

## Echtgeld: Freischaltung und Schutzmechanismen

Echtgeld-Handel erfordert **alle** folgenden Bedingungen:

1. `ADMIN_PASSWORD_HASH` gesetzt und angemeldet,
2. Bot-Wallet konfiguriert und befüllt,
3. mindestens eine Strategie im Status `PAPER_VALIDATED`,
4. Reconciliation „OK“,
5. **Live Trading → ENABLE REAL TRADING** (Eingabe der Bestätigungsphrase),
6. pro Strategie: **Strategy Lab → Strategie → ENABLE REAL TRADING**.

Schutzmechanismen, die sich **nicht abschalten** lassen: Prüfung von Zieladresse, Netzwerk
(Mainnet-Genesis-Hash), Token-Mint und erlaubten Programmen; Transaktionssimulation vor jeder
Signatur; Kostenberechnung; Guthabenprüfung inkl. Reserve; idempotente Orders (keine doppelten
Käufe nach Neustart); Bestätigungsüberwachung; Reconciliation (bei Abweichungen stoppt der Handel
mit „RECONCILIATION REQUIRED“).

Einstellbar (Settings → Risiko): Positionsgröße, max. Positionen, Tagesverlust, Exposure je Token
und Portfolio, Slippage, Priority Fee, Wallet-Reserve, Handelszeiten, erlaubte Strategien,
maximales Datenalter. **EMERGENCY STOP** (oben rechts) stoppt sofort alle neuen Live-Einstiege —
wahlweise werden offene Positionen sofort geschlossen oder weiter verwaltet.

---

## Sicherheit des privaten Schlüssels

- Der Schlüssel liegt nur verschlüsselt im Keystore (scrypt N=2¹⁷ + AES-256-GCM, Dateirechte 0600).
- Er wird nie angezeigt, geloggt, in der Datenbank gespeichert, über die API ausgegeben oder an den
  Browser übertragen. Das Dashboard kennt nur die öffentliche Adresse.
- Signiert wird nur nach bestandener Integritätsprüfung; der Signer verlangt eine an genau diese
  Transaktion gebundene, kurzlebige Freigabe.
- Logs werden zusätzlich gefiltert (API-Keys, Passphrasen, Schlüsselfelder).
- `.env`, `secrets/`, Keystores und Schlüsseldateien sind in `.gitignore`; die CI bricht ab, falls
  solche Dateien eingecheckt werden.
- Auszahlungen (Wallet → Senden) erfordern Anmeldung und die Bestätigung `SEND`.

---

## Betrieb: Backups, Updates, Monitoring

- **Backups:** Datenbank regelmäßig sichern, z. B.
  `docker compose exec postgres pg_dump -U multbot -Fc multbot > backup-$(date +%F).dump`.
  Keystore und Passphrase **getrennt und offline** sichern — ohne beides ist die Wallet verloren.
- **Updates:** `git pull && docker compose up -d --build`. Migrationen laufen automatisch und
  idempotent; offene Orders und Positionen werden beim Start wiederhergestellt.
- **Speicher:** Rohdaten werden nach einstellbaren Fristen gelöscht (Settings → Research →
  Datenaufbewahrung); Tages-Partitionen halten die Datenbank schlank.
- **Monitoring:** Settings → System zeigt alle Module, RPC-Endpoints (Latenz, Slot, Fehlerrate)
  und die Datenaufnahme. `/api/health` für externe Checks, `/metrics` (Prometheus, nur localhost).
- **Selbstheilung:** Module werden überwacht und bei Fehlern mit Backoff neu gestartet; der
  Research-Worker läuft in einem eigenen Thread und wird bei Absturz neu gestartet; Docker/systemd
  starten den Prozess neu.

---

## Projektstruktur und Dokumentation

```
apps/server     API, Datenaufnahme, Research-Worker, Paper-/Live-Engines (TypeScript, Fastify, PostgreSQL)
apps/web        Dashboard (React, Vite, Tailwind)
packages/shared Gemeinsame Typen, Einstellungen, Strategie-Spezifikation
deploy/         systemd-Unit
docs/           Architektur und Datenfluss
```

- [docs/architecture.md](docs/architecture.md) — Module, Threads, Sicherheitsarchitektur, Wiederanlauf
- [docs/data-flow.md](docs/data-flow.md) — vom Blockchain-Event bis zum Trade, Kausalität, Kostenmodell

---

## Tests

```bash
createdb multbot_test          # Testdatenbank (wird bei jedem Lauf neu aufgebaut)
pnpm typecheck && pnpm test
```

Die Tests decken u. a. ab: Decoder gegen echte Mainnet-Events, Kurvenmathematik, Discovery mit
eingebauten und fehlenden Signalen, Kausalität der Backtests, Kostenmodell, Keystore/Signer,
Transaktionsprüfung (Drain-Versuche, fremde Programme), Live-Engine inkl. Ledger und Steuer, sowie
Ausfallszenarien: RPC-/WebSocket-/Datenbank-Ausfall, doppelte Events, fehlgeschlagene und
teilweise Ausführung, zu hohe Slippage, ungültige Tokens, veraltete Daten, Absturz vor/nach dem
Senden einer Order und Neustart mit offenen Positionen.

---

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| Dashboard fragt nach Login | `ADMIN_PASSWORD_HASH` ist gesetzt — mit dem Passwort anmelden. |
| „no bot wallet keystore“ | Wallet anlegen (Schritt 3) und Container/Server neu starten. |
| „keystore … readable by group/others“ | `chmod 600 secrets/*` (und bei Docker Besitzer 1000). |
| Feed „DISCONNECTED“ | RPC/WebSocket prüfen (Settings → System); Helius-Key gesetzt? |
| „RECONCILIATION REQUIRED“ | Live Trading → Reconciliation: Abweichungen prüfen, ggf. auf Solscan nachsehen, dann bestätigen. |
| Discovery findet nichts | Normal bei wenig Daten. Nach einigen Tagen Laufzeit erneut prüfen. |
| Docker-Build hinter Firmen-Proxy | `docker build --secret id=extra_ca,src=ca.crt --build-arg NODE_IMAGE=<mirror>/node:22-bookworm-slim .` |
