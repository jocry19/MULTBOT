# Datenfluss

Vom Blockchain-Ereignis bis zum Trade — und zurück in die Forschung.

```
Pump.fun / PumpSwap Programm-Logs (logsSubscribe, commitment "confirmed")
  │  PumpStream: Duplikate (gleiche Signatur) verwerfen, fehlgeschlagene Tx ignorieren
  ▼
Anchor-Event-Decoder (logParser, events, borsh) ──► normalizeEvents
  │  nur SOL-notierte Märkte; unbekannte Pools on-chain auflösen (Quote-Mint prüfen)
  ▼
MarketEvent[] (trade · create · complete · migrate · pool · liquidity), available_at = Empfangszeit
  ├──► DataCollector ──► market_trades, tokens, data_gaps          (Rohdaten, gepuffert)
  └──► MarketIndexer
         │  TokenState: Curve-/Pool-Zustand, Tape, Kerzen, Holder, Creator-Flow
         │  WalletBook: Positionen und Verhalten aller beobachteten Trader
         ▼
       Entscheidungszeitpunkte (Alters-Checkpoints 15 s … 1 h, Ereignisse, alle 120 s)
         │  FeatureEngine (~170 Merkmale, nur bis zum Zeitpunkt verfügbare Daten)
         │  ContextBaselines (robuste z-Werte/Perzentile relativ zu Alter × Venue)
         │  EventEngine (23 Detektoren) · RegimeEngine (Aktivität, Volatilität, Liquidität, Breite, Flow)
         ├──► token_state (Dashboard, „Warum auffällig?“), events, market_regimes
         ├──► research_samples (Features + Kontext, noch ohne Ergebnis)
         └──► Bus: market.decision ──► PaperEngine / LiveEngine
```

## Kausalität

Jeder Datensatz trägt zwei Zeitstempel:

- `ts` — wann es on-chain passiert ist,
- `available_at` — wann MULTBOT es erfahren hat (Empfang, ggf. Pool-Auflösung).

Features zu einem Zeitpunkt *t* verwenden nur Daten mit `available_at ≤ t`. Backtests und Labels
setzen den Einstieg **nach** der Ausführungsverzögerung an (Standard 1,5 s) und verwenden den dann
gültigen Curve-/Pool-Zustand. Research-Daten werden chronologisch in Training / Validierung / Holdout
getrennt, mit einer Sperrzone (Embargo) von der längsten Label-Dauer dazwischen.

## Research-Kreislauf (Worker-Thread)

```
research_samples ──► OutcomeLabeler
                     │ realistische Ein-/Ausstiege über 7 Horizonte (30 s … 1 h) und TP/SL-Raster,
                     │ Pfad t+0 … t+24 h, Gebühren, Slippage, Priority/Netzwerk-Fees, Rent, MEV,
                     │ fehlgeschlagene Tx; Datenlücken → kein Label
                     ▼
                   gelabelte Samples ──► Situations-Cluster (k-Means), Analog-Index (kNN)
                     │
                     ▼
                   DiscoveryEngine
                     │ Atome (Quantil-Schwellen, abgeleitete Kombinationen) → Rezepte bis 3 Bedingungen
                     │ Pro-Token-Cooldown gegen korrelierte Stichproben
                     │ t-Test → Benjamini–Hochberg über ALLE getesteten Hypothesen
                     │ Validierung, Walk-Forward (neu gefittete Schwellen), Deflated Sharpe, Holdout
                     │ Anti-Blindness-Report, Near-Misses, Regime-Aufschlüsselung
                     ▼
                   strategies / strategy_versions (DISCOVERED)
                     ▼
                   BacktestRunner (kausal, auf gespeicherten Trades) → PAPER_TRADING oder REJECTED
                     ▼
                   StrategyMonitor (alle 5 min)
                     │ Validierung → PAPER_VALIDATED (Empfehlung) · signifikanter Verfall → DEGRADED
                     │ Herausforderer-Vergleich auf demselben Live-Zeitraum
                     ▼
                   LearningEngine: Erwartung vs. Ergebnis, Entscheidungs- vs. Ergebnisqualität,
                     │ Attribution (Regime, Slippage, Marktbewegung), kalibrierte Erwartung
                     ▼
                   EvolutionRunner: Varianten (Exit, Schwellen, Regime-Filter, Vereinfachung),
                     Auswahl auf älteren, Bestätigung auf neueren Daten → Herausforderer-Version
                     → Backtest → Paper-Vergleich → Beförderung / Empfehlung / Ausmusterung
```

## Trading-Pfad

```
market.decision (Features, Regime, Auslöser)
  │
  ├─ PaperEngine (je aktive Version inkl. Herausforderer)
  │    matchSpec → Signal (idempotent) → simulierte Ausführung nach Verzögerung gegen den dann
  │    aktuellen Zustand → Position → Exits (TP/SL/Trailing/Haltedauer/Invalidierung/Feature-Exits)
  │    → paper_trades (brutto und netto, alle Kostenarten)
  │
  └─ LiveEngine (nur LIVE_ENABLED und Echtgeld-Modus ACTIVE)
       RiskEngine: Modus, Bot läuft, Reconciliation OK, RPC gesund, Daten frisch, Handelszeiten,
       max. Positionen, Exposure je Token/Portfolio, Tagesverlust, Guthaben + Reserve, Slippage
       │
       ▼
       ExecutionEngine: Quote → Transaktion bauen → TxGuard → Simulation → Kosten/Guthaben →
       signieren → Signatur speichern → senden → Bestätigung → tatsächliche Salden übernehmen
       │
       ▼
       live_trades · orders · transactions · ledger_entries (Hash-Kette) · tax_lots/tax_disposals
       │
       ▼
       Reconciler gleicht DB und Blockchain regelmäßig ab
```

## Kostenmodell (Paper, Backtest, Labels)

| Kostenart | Quelle |
| --- | --- |
| DEX-/Creator-/Protokollgebühren | aus beobachteten Trade-Events (dynamische Gebührenstufen) |
| Slippage | exakte Curve-/Pool-Mathematik (bigint) für die Positionsgröße |
| Ausführungsverzögerung | Einstieg/Ausstieg zum Zustand nach `executionDelayMs` |
| Priority Fee, Netzwerkgebühr | Einstellung bzw. Helius-Schätzung |
| MEV/Latenz | Aufschlag in bps (Einstellung) |
| Rent | Token-Konto beim Einstieg, Rückerstattung beim Schließen |
| Fehlgeschlagene Transaktionen | Wahrscheinlichkeit (Einstellung): Gebühren bezahlt, keine Position |

Ausgewertet wird immer **netto**. Brutto wird zusätzlich angezeigt, damit sichtbar ist, wie viel
eines Vorteils die Kosten auffressen.

## Dashboard-Aktualisierung

Der Server sendet über `/api/stream` (WebSocket): Aktivitäten (Bot-Ereignisfeed), System-Health und
Invalidierungen (`paper`, `live`, `wallet`, `strategies`). Das Dashboard lädt daraufhin nur die
betroffenen Ansichten neu; zusätzlich laufen moderate Polling-Intervalle als Rückfallebene.
