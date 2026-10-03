# Datenbank

PostgreSQL 16. Migrationen in `packages/database/src/migrations` (idempotent, mit Advisory-Lock und
Prüfsumme); `pnpm db:migrate` legt zusätzlich Tagespartitionen für die nächsten Tage an.

## Tabellen

| Bereich | Tabellen |
|---|---|
| Benutzer & Steuerung | `users`, `sessions` (nur SHA-256 der Tokens), `settings` + `settings_audit` (unveränderlich), `system_state` (Bot, Gate, Notstopp, Breaker, Shadow, Strategie …), `system_events`, `notifications` |
| Markt | `wallets`, `tokens`, `pools`, `watchlist`, `quotes` (partitioniert), `priority_fees`, `fx_rates` |
| Strategie | `strategy_versions` (nicht löschbar), `strategy_parameters` (unveränderlich) |
| Entscheidungen | `opportunities` (partitioniert, **jede** bewertete Opportunity inkl. abgelehnter: Kosten, Ladder, Wasserfall, Legs, Features), `no_trade_stats` (Screening-Ablehnungen pro Minute) |
| Ausführung | `paper_trades`, `live_trades`, `execution_attempts` (Idempotenz-Schlüssel eindeutig), `transactions`, `fees`, `jito_bundles` — alle nicht löschbar |
| Learning & Risiko | `learning_metrics`, `risk_events` (unveränderlich), `balance_checks` |
| Steuer | `tax_lots`, `tax_transactions` (unveränderlich) |

Beträge on-chain sind `NUMERIC(40,0)` in Rohe-Einheiten (Lamports / Token-Basiseinheiten). Learning-Samples
werden mit dem Trade gespeichert (`learning` JSONB), damit das Learning nach jedem Neustart vollständig
wiederhergestellt wird.

## Unveränderlichkeit

Trigger `forbid_delete` (Trades, Versuche, Transaktionen, Strategie-Versionen) und `forbid_mutation`
(Audit, Risiko-Ereignisse, Strategie-Parameter, Steuer-Transaktionen) setzen den Prüfpfad auf
Datenbankebene durch.

## Aufbewahrung

`drop_daily_partitions_before(parent, cutoff)` entfernt ganze alte Tagespartitionen von `quotes` und
`opportunities` ohne Tabellen-Bloat. Backup: `infrastructure/database/backup.sh` (pg_dump, 14 Tage).
