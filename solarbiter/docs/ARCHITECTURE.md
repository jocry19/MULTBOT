# Architektur

## Prozesse

```
            ┌──────────── Browser (Dashboard, statischer Next.js-Export) ────────────┐
            │  REST /api/*  ·  WebSocket /api/ws  (Session-Cookie, CSRF-Header)      │
            └──────────────────────────────┬─────────────────────────────────────────┘
                                           │
                       ┌───────────────────▼───────────────────┐
                       │ API (Fastify)                          │  keine Schlüssel, kein Trading
                       │ Auth · Steuerung · Reports · Export    │
                       └───────┬───────────────────────┬────────┘
                    DB-Zustand │ (Quelle der Wahrheit)  │ Redis: sb:control ↓ / sb:events ↑
                       ┌───────▼───────┐       ┌────────▼────────┐
                       │ PostgreSQL    │◄──────┤ Worker           │  einziger Prozess mit Signer
                       └───────────────┘       │ Engine-Schleife  │
                                               └────────┬─────────┘
                       Solana-RPC · Jupiter · Raydium/Orca/Meteora-APIs · Jito · Kraken (SOL/EUR)
```

- **Worker** (`apps/worker`): Startsequenz, Marktdaten, Scanner, Risk, Paper/Shadow/Live, Learning,
  Breaker, Status-Snapshots. Er ist der einzige Prozess, der das Bot-Wallet lädt.
- **API** (`apps/api`): Login, REST, WebSocket-Weiterleitung, Steuerbefehle. Steuerung schreibt
  zuerst den Zustand in die Datenbank und signalisiert dann den Worker über Redis; ein verlorenes
  Redis-Signal ist harmlos (der Worker liest den Zustand alle 10 s neu).
- **Dashboard** (`apps/web`): statischer Export, von der API same-origin ausgeliefert.

## Entscheidungskette

```
Market Data → Quote Engine → Scanner → Profit Calculator → Risk Engine → Paper/Shadow
            → Learning → Validation Gate → Live Execution → Wallet / Tax
```

| Schritt | Paket | Kern |
|---|---|---|
| Market Data | `dex`, `solana`, `raydium`, `orca`, `meteora` | Pool-Discovery (API + On-Chain-Prüfung), gebündeltes Lesen, Decoder |
| Quote Engine | `jupiter`, `quotes` | DEX-gebundene Firm-Quotes, Request-Budget (60-s-Fenster), Frische |
| Scanner | `arbitrage` | Screening direkt/triangulär, Kandidaten-Queue, Size-Ladder |
| Profit Calculator | `profit-engine` | `calculateNetProfit`, EV, Sicherheitspuffer, Schluss-Leg-Guard |
| Risk Engine | `risk-engine` | `validate()`, Freigaben, Breaker, Sizing, Live-Levels |
| Paper / Shadow | `paper-engine` | Ausführung nach Latenz mit Re-Quotes, Portfolios |
| Learning | `learning-engine` | Modelle, Validierung, Live-Gate, Optimizer |
| Live Execution | `execution-engine`, `jito`, `wallet` | atomare Transaktion, Simulation, Guard, Signer, Bundle |
| Wallet / Tax | `wallet`, `tax` | Salden, Abgleich, FIFO-Steuerdokumentation |

DEX-Logik existiert nur hinter dem Interface `DexAdapter` (`getQuote`, `buildSwap`, `getLiquidity`,
`getFees`, `validateRoute`, plus Discovery/State-Decoding). Der Profit-Calculator kennt keine DEX.

## Pakete

`shared` (Typen, Einstellungen, Geldmathematik, Statistik; `shared/node`: Logger mit Secret-Scrubbing,
Config, Redis-Bus, Metriken) · `database` (Migrationen, State-Store) · `solana` (RPC-Manager mit
Failover, Priority-Fee-Orakel, Mint-Decoder, Token-Registry) · `quotes` · `dex` · `jupiter` ·
`raydium` · `orca` · `meteora` · `jito` · `arbitrage` · `profit-engine` · `risk-engine` ·
`paper-engine` · `learning-engine` · `execution-engine` · `wallet` · `tax` · `notifications`.

Pakete exportieren `src/*.ts` unter der Condition `source` (Entwicklung, Tests) und `dist/*.js` im
Build.

## Bot-Zustände

`OFFLINE · INITIALIZING · NOT_READY · PAPER · SHADOW · LIVE · PAUSED · EMERGENCY_STOP`, dazu das
Live-Gate `LIVE_LOCKED → LIVE_READY → LIVE_ENABLED`. Der effektive Zustand wird im Worker berechnet:

```
nicht bereit → NOT_READY ; Notstopp → EMERGENCY_STOP ; pausiert → PAUSED ;
Gate LIVE_ENABLED ∧ LIVE_MODE ∧ Wallet → LIVE ; Shadow ∧ Wallet → SHADOW ; sonst PAPER
```

`LIVE_READY` setzt nur das Learning (Empfehlung). `LIVE_ENABLED` setzt nur der Mensch.
