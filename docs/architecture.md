# Architektur

MULTBOT ist ein einzelner Node.js-Prozess (TypeScript, ESM) mit einem zusätzlichen Worker-Thread für
rechenintensive Research, einer PostgreSQL-Datenbank und einem statischen React-Dashboard, das vom
selben Server ausgeliefert wird.

```
                    ┌──────────────────────── Hauptprozess (apps/server) ─────────────────────────┐
 Solana RPC/WS ───► │ RpcManager ─ SolanaWsClient ─ PumpStream ─► TypedBus ─► MarketIndexer        │
 (Helius, Fallback) │     ▲                          │ (market.events)     │ Features, Events,     │
                    │     │                          ▼                     │ Regime, Samples       │
                    │ WalletService ◄── Reconciler   DataCollector ──► PostgreSQL ◄───┐             │
                    │     │  Signer (Keystore)                                        │             │
                    │     ▼                                                           │             │
 Jupiter API ◄───── │ ExecutionEngine ◄── LiveEngine ◄─ market.decision ─ PaperEngine │             │
                    │   TxGuard, Simulation   │ RiskEngine, Ledger, TaxLedger          │             │
                    │                          │                                       │             │
                    │ Fastify API + WebSocket-Stream ──► Dashboard (apps/web)          │             │
                    │ ResearchHost ═══ worker_thread ══► ResearchRuntime ──────────────┘             │
                    └──────────────── Labeler · Discovery · Backtests · Monitor · Learning · Evolution ┘
```

## Pakete

| Paket | Inhalt |
| --- | --- |
| `packages/shared` | Enums, Einstellungs-Schemas (zod) mit Standardwerten, Strategie-Spezifikation, API-DTOs. Wird von Server und Dashboard genutzt; der Server validiert jede Einstellungsänderung damit. |
| `apps/server` | Alle Laufzeitmodule, REST-API, WebSocket-Stream, CLI-Werkzeuge, Migrationen. |
| `apps/web` | Dashboard (React 19, TanStack Query, lightweight-charts, Tailwind). Enthält nie Schlüsselmaterial. |

## Modulsystem

Jedes Laufzeitmodul erbt von `BaseModule` (`core/module.ts`): Start/Stop, periodische Aufgaben mit
Fehlerzählung und Backoff, Health-Status (`CONNECTED` / `DISCONNECTED` / `DISABLED` …) und eine
Detailzeile für das Dashboard. Die `ModuleRegistry` startet Module in fester Reihenfolge und stoppt
sie in umgekehrter Reihenfolge. Module sind entkoppelt über den typisierten Event-Bus (`TypedBus`):
`market.events`, `market.decision`, `market.price`, `activity`, `invalidate`.

**Startreihenfolge (Crash-Recovery):**

1. Migrationen (Advisory Lock, Prüfsummen, idempotent) → Einstellungen → Pool-Registry
   (Quote-Mints prüfen, Nicht-SOL-Märkte bereinigen)
2. Housekeeping (Retention, Sitzungen), RPC-Manager
3. Wallet (Kontostand, Token-Bestände, Historie) → **Reconciliation** (offene Orders fortsetzen,
   hängende Trades auflösen, Bestände mit DB abgleichen; bei Abweichungen `REQUIRED` = kein Handel)
4. Wallet-Analyse, Market-Indexer (Warmstart aus der DB), Collector, Research-Worker
5. Paper-Engine (offene Positionen wiederherstellen, unterbrochene Einstiege schließen)
6. Live-Engine (offene/schließende Positionen laden), zuletzt die Datenaufnahme

## Threads und Isolation

- **Hauptthread:** Datenaufnahme, Marktzustand, Features, Paper/Live-Engines, API. Latenzkritisch.
- **Research-Worker** (`worker_threads`): Outcome-Labeling, Discovery, Backtests, Situations-Cluster,
  Analog-Index, Strategie-Monitor, Learning Engine, Evolution. Kommunikation über ein typisiertes
  Nachrichtenprotokoll (`research/protocol.ts`). Der `ResearchHost` startet den Worker bei Absturz
  mit begrenztem Backoff neu; Einstellungsänderungen werden live übertragen.

## Datenbank

PostgreSQL mit täglich partitionierten Zeitreihen (`market_trades`, `volume_snapshots`,
`liquidity_snapshots`, `token_snapshots`, `research_samples`). Retention löscht ganze Partitionen
(kein Tabellen-Bloat). Wichtige Tabellen:

| Bereich | Tabellen |
| --- | --- |
| Markt | `tokens`, `token_state`, `market_trades`, `holders`, `creators`, `events`, `market_regimes`, `data_gaps` |
| Wallets | `wallets`, `wallet_positions`, `wallet_events`, `wallet_clusters` |
| Research | `research_samples`, `features`, `situation_clusters`, `discovery_runs`, `hypotheses`, `evolution_runs` |
| Strategien | `strategies`, `strategy_versions` (unveränderliche Specs, Herausforderer), `strategy_status_history`, `strategy_results`, `backtests`, `backtest_trades` |
| Trading | `signals`, `paper_trades`, `live_trades`, `orders`, `transactions` |
| Buchhaltung | `ledger_entries` (Hash-Kette, UPDATE/DELETE per Trigger verboten), `tax_lots`, `tax_disposals`, `fx_rates` |
| System | `settings`, `settings_audit`, `system_state`, `bot_activity`, `notifications`, `auth_sessions`, `learning_updates`, `learning_state` |

Doppelte Verarbeitung wird über eindeutige Schlüssel verhindert: `(signature, event_index)` für
Trades, `event_uid` für Events, `idempotency_key` für Signale, Paper-/Live-Trades und Orders.

## Sicherheitsarchitektur

**Schlüsselverwaltung**

- Keystore-Datei: scrypt (N=2¹⁷, r=8, p=1) + AES-256-GCM, Dateirechte 0600; Keystores, die für
  Gruppe/Andere lesbar sind, werden verweigert. Passphrase nur aus Umgebung oder Datei.
- Der entschlüsselte Schlüssel existiert nur im `Signer`-Objekt des Hauptprozesses. Der Signer
  signiert nur mit einer **Integritätsfreigabe**, die an den Hash genau dieser Nachricht gebunden
  und 60 Sekunden gültig ist. Diese Freigabe stellt ausschließlich `TxGuard` nach bestandenen
  Prüfungen aus.
- Kein Schlüsselmaterial in Logs (Pino-Redaction + Secret-Scrubber für registrierte Geheimnisse und
  API-Keys in URLs), in der Datenbank, in API-Antworten, im Browser oder in Git (`.gitignore`,
  CI-Wächter).

**Prüfungen vor jeder Signatur (`ExecutionEngine` + `TxGuard`), nicht abschaltbar**

1. Netzwerk: Genesis-Hash muss Solana Mainnet sein.
2. Token-Mint existiert und gehört einem Token-Programm.
3. Transaktion: nur erlaubte Programme, Fee-Payer = Bot-Wallet, SOL-Transfers nur in eigene
   Konten (WSOL-ATA), Konto-Schließungen nur zugunsten der Bot-Wallet, Priority Fee begrenzt.
4. Price Impact ≤ Slippage-Limit, Mindest-Output aus dem Quote.
5. Simulation: kein Fehler, SOL-Abfluss und Token-Zufluss innerhalb der erwarteten Grenzen.
6. Guthaben: Betrag + Gebühren + Rent + Reserve verfügbar.
7. Signieren → Signatur **vor** dem Senden speichern → senden → Bestätigung überwachen (Rebroadcast
   bis Blockhash-Ablauf) → tatsächliches Ergebnis aus der bestätigten Transaktion übernehmen.

**Echtgeld-Freigabe:** Der Übergang zu `LIVE_ENABLED` ist im Status-Automaten ausschließlich für den
Akteur `user` erlaubt; die API verlangt Anmeldung, CSRF-Header und die Bestätigungsphrase. Die
Evolution darf die Version einer Echtgeld-Strategie nicht selbst ändern (nur empfehlen).

**API:** Sitzungs-Cookies (httpOnly, SameSite=Strict, nur SHA-256 der Tokens gespeichert),
`X-Requested-With`-Pflicht für verändernde Anfragen, Echtgeld-Endpunkte nur mit konfiguriertem
Admin-Passwort, `/metrics` nur von localhost.

## Betriebsstabilität

- **RPC-Manager:** mehrere Endpunkte, Health (Latenz, Slot, Slot-Abstand, Fehlerrate),
  Token-Bucket-Ratenlimits, Circuit Breaker, begrenzte Wiederholungen, Failover; kritische Lesezugriffe
  optional gegen einen zweiten Endpunkt verifiziert.
- **WebSocket:** automatisches Resubscribe, Failover, Ping, Stale-Watchdog; Ausfallzeiten werden als
  `data_gaps` gespeichert und in Research berücksichtigt.
- **Collector:** gepuffertes Schreiben; bei DB-Ausfall bleibt der Puffer erhalten (begrenzt,
  Überlauf wird als Datenlücke protokolliert).
- **Reconciliation:** periodisch und beim Start; stoppt den Echtgeld-Handel bei Abweichungen.
- **Housekeeping:** Retention, Partitionen, Sitzungsbereinigung; Log-Rotation im Prozess.
- **Supervision:** Modul-Backoff, Worker-Neustart, Docker `restart: unless-stopped` + Healthcheck
  bzw. systemd `Restart=always`.
