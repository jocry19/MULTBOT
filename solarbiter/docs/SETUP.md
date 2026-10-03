# Setup

> **Einfachster Weg:** Docker Desktop installieren und `SOLARBITER starten` doppelklicken (`.bat` unter
> Windows, `.command` unter macOS) — siehe [README](../README.md#start-per-doppelklick). Das Skript
> (`scripts/launcher/`) richtet `.env` und den Dashboard-Benutzer beim ersten Start ein. Die folgenden
> Schritte sind für den Betrieb ohne Docker bzw. für Entwicklung.

## Voraussetzungen

- Node.js ≥ 22, pnpm 10 (`corepack enable`)
- PostgreSQL 16 und Redis 7 (lokal oder per `docker compose up -d postgres redis`)

## Installation

```bash
cd solarbiter
pnpm install
cp .env.example .env
```

Wichtige Einträge in `.env` (alle mit Kommentar in `.env.example`):

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Verbindungen |
| `SOLANA_RPC_URL`, `SOLANA_RPC_FALLBACK_URLS` | RPC (öffentlicher Endpoint reicht für Paper; für ernsthaften Betrieb einen eigenen nutzen) |
| `JUPITER_API_KEY`, `JUPITER_RPS` | ohne Key 0,5 rps (30 Requests / 60 s); mit Key wechselt der Client automatisch auf `api.jup.ag` |
| `LIVE_MODE` | `false` = Echtgeld technisch unmöglich (Standard) |
| `STARTING_CAPITAL_EUR`, `MAX_TRADE_EUR`, … | Startwerte der Einstellungen (danach im Dashboard, mit Audit) |
| `WALLET_KEYSTORE_PATH`, `WALLET_KEYSTORE_PASSPHRASE(_FILE)` | nur für Shadow/Live |

## Datenbank und Benutzer

```bash
pnpm db:migrate        # Migrationen + Partitionen der nächsten Tage
pnpm db:seed           # Einstellungen, Watchlist, strategy_v1, Steuerzustand (PAPER, Live gesperrt)
pnpm user:create admin # Passwort über stdin, mindestens 12 Zeichen
```

## Start

```bash
pnpm dev:worker                          # Worker (tsx, Quellcode)
WEB_DIST_DIR=apps/web/out pnpm dev:api   # API + Dashboard auf http://127.0.0.1:8788
pnpm --filter @solarbiter/web build      # Dashboard einmalig exportieren
```

Für Frontend-Entwicklung mit Hot-Reload: `pnpm dev:web` (Port 3000, leitet `/api` an die API weiter).

Die **Startsequenz** des Workers prüft der Reihe nach: Config → Datenbank (+ Migrationen) → Redis →
Einstellungen → Solana-RPC → SOL/EUR → Token (on-chain) → DEX-Adapter → Quote-Provider →
Pools → Wallet → Jito → Ausführungsschicht → Risk-Zustand → Strategie → Learning → Portfolios. Jeder
Schritt erscheint im Dashboard (Settings → Startsequenz). Schlägt ein kritischer Schritt fehl, bleibt
der Bot in **BOT NOT READY**, zeigt die Gründe und versucht es alle 30 s erneut.

## Bot-Wallet (optional, für Shadow / Live)

```bash
mkdir -p secrets && chmod 700 secrets
printf '%s' 'eine-lange-passphrase' > secrets/wallet_passphrase && chmod 600 secrets/wallet_passphrase
WALLET_KEYSTORE_PASSPHRASE_FILE=./secrets/wallet_passphrase pnpm wallet:create
pnpm wallet:address
```

Die Adresse mit SOL aufladen. Der private Schlüssel erscheint nie auf dem Bildschirm, in Logs, in der
Datenbank oder im Frontend (siehe [WALLET](WALLET.md)).

## Tests

```bash
pnpm test                                   # alle Tests (benötigt PostgreSQL + Redis)
SOLARBITER_LIVE_TESTS=1 pnpm vitest run tests/integration   # Mainnet-Lesetest (read-only)
```
