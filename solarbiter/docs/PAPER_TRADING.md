# Paper- und Shadow-Trading

Paper ist der Standardmodus. Marktdaten, Quotes, Kostenmodell und Risk-Gate sind **identisch** mit
Live; nur die Ausführung ist virtuell. Paper- und Live-Portfolio sind getrennte Objekte und Tabellen
und werden nie vermischt.

## Ablauf

```
DETECTED → QUOTE → (SIMULATE, nur Shadow) → WAIT LATENCY → REQUOTE → CALCULATE → CLOSE
```

1. **QUOTE** — die Firm-Quotes der Entscheidung, Risk-Freigabe (einmalig, gebunden).
2. **SIMULATE** (Shadow) — die echte atomare Transaktion wird gebaut und mit dem Bot-Wallet per
   `simulateTransaction` geprüft. Eine fehlgeschlagene Simulation wird nie „gesendet“: kein Kosten,
   aber ein Fehlschlag für das Learning.
3. **WAIT LATENCY** — die gelernte Latenz Entscheidung → Landung (Standard `defaultLatencyMs`,
   900 ms, bis genug Messungen vorliegen).
4. **REQUOTE** — jede Leg wird mit genau den Mengen neu gequotet, die die Transaktion tauscht:
   Leg 1 die Größe, Zwischen-Legs das Minimum der Vor-Leg, die Schluss-Leg die tatsächlich gelieferte
   Menge (Token-Ledger).
5. **CALCULATE** — dieselben Mindest-Outputs wie live entscheiden: unterschreitet eine Leg ihr
   Minimum bzw. die Schluss-Leg den Profit-Guard → **Revert** (via Jito 0 Kosten, via RPC Basis- +
   Priority-Fee). Sonst: realisiert = Schluss-Output − Input − Gebühren − Tip.
6. **CLOSE** — Paper-Trade mit Prognosefehler und Learning-Sample gespeichert, Portfolio aktualisiert.

Gewinne werden nie angenommen: sie kommen ausschließlich aus Re-Quotes. Ist ein Re-Quote nicht
verfügbar, ist das Ergebnis **unbekannt** — es wird weder als Gewinn noch als Verlust gezählt.

## Was Paper nicht sehen kann

Die Konkurrenz um Blockplatz (andere Searcher, Bundle-Auktionen). Darum wird live der Unterschied
zwischen prognostiziertem und realisiertem Ergebnis gemessen; ist live um mehr als
`liveDegradationBps` schlechter, wird automatisch abgestuft bzw. zurück zu Paper geschaltet.

## Shadow-Modus

Einschalten unter *Paper Trading → Shadow-Modus an*. Voraussetzung: konfiguriertes, gedecktes
Bot-Wallet (die Simulation braucht echtes Guthaben). Nichts wird signiert oder gesendet.

## Paper-Konto neu starten (anderes Startkapital)

*Paper Trading → Paper-Konto neu starten*: neues Startkapital eingeben (z. B. 300 €) und bestätigen
(`POST /api/paper/reset {capitalEur}`; der Bot muss laufen, weil der SOL/EUR-Kurs gebraucht wird).
Das virtuelle Konto startet sofort neu, ohne Neustart des Bots. Frühere Paper-Trades bleiben
gespeichert (Verlauf, Learning); Kapital, Equity-Kurve und Kennzahlen zählen ab dem Neustart. Echtgeld
ist davon nicht betroffen.

Mehr Kapital allein ändert die Trade-Größe nicht: Die Obergrenze ist das Minimum aus `maxTradeEur`,
Kapital-Skalierung (≥ 100 € → 20 €) und Reserve. Für größere Paper-Trades unter *Einstellungen*
`capital.maxTradeEur` und `strategy.tradeSizesEur` erhöhen (Risikoerhöhung, darum mit Passwort). Live
bleibt zusätzlich durch das Live-Level begrenzt (1 / 2 / 3 / 5 €).
