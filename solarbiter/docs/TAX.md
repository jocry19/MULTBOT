# Steuer-Dokumentation

> **Keine Steuerberatung.** SOLARBITER dokumentiert Transaktionen so, dass Steuerberater oder
> Steuersoftware sie auswerten können. Jede Exportdatei beginnt mit diesem Hinweis.

## Was dokumentiert wird

Nur **Live**-Transaktionen (Paper-Trades sind keine steuerlichen Ereignisse). Eine atomare Arbitrage
SOL → A (→ B) → SOL wird als Folge von Tauschvorgängen erfasst:

| Zeile | Inhalt |
|---|---|
| swap SOL → A | Veräußerung von SOL (FIFO-Anschaffungskosten), Anschaffung von A zum EUR-Wert des hingegebenen SOL |
| swap A → SOL | Veräußerung von A (Anschaffungskosten aus der vorigen Zeile), Anschaffung von SOL zum EUR-Wert des erhaltenen SOL |
| fee | Netzwerkgebühr + Priority-Fee + Jito-Tip als SOL-Abgang |

Je Zeile: Zeitstempel (UTC), Signatur, Wallet, Assets und Mengen, EUR-Wert, SOL/EUR-Kurs und dessen
Zeitpunkt (Kraken), Gebühren in SOL und EUR, Anschaffungs- und Veräußerungswert, realisierter
Gewinn/Verlust, Haltedauer der verbrauchten Lots, DEX, Route, Live-Trade-ID.

## Grundsätze

- **FIFO je Asset** (`tax_lots`); Lots werden nie gelöscht, nur ihr Restbestand sinkt.
- **Unbekannte Anschaffungskosten bleiben unbekannt** (z. B. SOL, das vor Beginn der Aufzeichnung im
  Wallet war, oder Einzahlungen ohne angegebenen Kaufpreis) — sie werden nie geschätzt; die Übersicht
  zählt solche Fälle.
- Zwischenmengen (Token innerhalb derselben Transaktion) stammen aus der ausgeführten Quote; sie
  beeinflussen den Gewinn nicht, weil Anschaffung und Veräußerung im selben Slot zum selben EUR-Wert
  erfolgen.
- `tax_transactions` ist in der Datenbank unveränderlich (Trigger).

## Export

*Tax → CSV/JSON herunterladen* (Zeitraum wählbar) bzw. `GET /api/tax/export?format=csv|json&from=&to=`.
