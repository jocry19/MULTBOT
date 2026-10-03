# Tests

```bash
pnpm test          # alle Tests (Vitest); benötigt PostgreSQL (solarbiter_test) und Redis
pnpm typecheck     # alle Pakete und Apps
```

Die Datenbank-Tests verwenden `TEST_DATABASE_URL` (Standard
`postgres://solarbiter:solarbiter@localhost:5432/solarbiter_test`) und setzen das Schema jeweils neu auf.

## Unit-Tests (pro Paket)

| Paket | Schwerpunkte |
|---|---|
| `dex` | Decoder gegen echte Mainnet-Accounts (v4, CPMM, CLMM, Whirlpool, DLMM — Preise stimmen < 0,5 % überein) |
| `jupiter` | Quote-Mapping, DEX-Filter, Request-Budget, Dekodierung der Swap-Instruktionen (inkl. Token-Ledger), Ablehnung manipulierter Builds, Circuit |
| `raydium` / `orca` / `meteora` | Discovery mit On-Chain-Verifikation, State-Decoding, Liquidität |
| `solana` | RPC-Failover, Token-Registry und Sicherheitsregeln |
| `profit-engine` | Kostenmodell (jede Kostenschicht genau einmal), EV, Ablehnungsgründe, Puffer, Size-Ladder |
| `risk-engine` | `validate()`, Freigaben (fälschungssicher, einmalig, ablaufend), Limits, Sizing ohne Martingale, Breaker, Live-Levels |
| `arbitrage` | Screening, Queue inkl. Backoff, Evaluator |
| `paper-engine` | Ausführungsablauf, Reverts (Jito vs. RPC), Shadow, unbekannte Ergebnisse, Portfolio |
| `learning-engine` | Modelle, chronologischer Split, Walk-Forward, Gate, Optimizer, Rollback |
| `execution-engine` | atomare Komposition mit echten Jupiter-Instruktionen und Lookup-Tables, Guard, Live-Ablauf (finaler Check, Simulation, Signieren, Bestätigung, Idempotenz) |
| `jito`, `wallet`, `tax`, `notifications`, `database` | Tips/Bundles, Keystore/Signer/Guard, FIFO und Export, Scrubbing, Migrationen und Unveränderlichkeit |

## Integrationstests

- `apps/api/src/api.test.ts` — echte Datenbank + Redis: Auth, CSRF, Live-Gate-Ablehnung, Notstopp,
  Passwortpflicht bei Risikoerhöhung, Steuer-Export, kein Schlüsselmaterial, Logout.
- `tests/integration/live-market.test.ts` — **read-only gegen Mainnet** (opt-in mit
  `SOLARBITER_LIVE_TESTS=1`): Token-Registry, Pool-Discovery auf allen drei DEXs mit konsistenten
  Preisen, DEX-gebundene Firm-Quote und verifizierter Mindest-Output.

## Simulation

`tests/simulation/pipeline.test.ts` — 300 Märkte mit zufälliger Fehlbewertung und Drift durch die
komplette Pipeline. Geprüft wird bei jedem Trade: nur mit positiver Kante über den Schwellen,
Größe innerhalb der Limits, Reverts kosten via Jito 0 und via RPC genau die Gebühren, gelandete
Trades erreichen den Mindestgewinn, das Paper-Saldo ändert sich exakt um das Ergebnis; faire Märkte
erzeugen keinen einzigen Trade; das Tageslimit stoppt den Handel.

## Chaos

`tests/chaos/failures.test.ts` — Ausfall des Quote-Providers während der Bewertung, langsame/veraltete
Quotes, Ausfall während eines laufenden Trades, Preissturz in der Latenz, Wiederverwendung einer
Freigabe, Concurrency, Notstopp/Pause, jeder Circuit Breaker, echte Datenbank- und Redis-Ausfälle,
429-Sturm beim Routing-API.
