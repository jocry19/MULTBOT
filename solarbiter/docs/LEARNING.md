# Learning

Statistisches Lernen — kein blindes Reinforcement Learning. Das Learning liefert nur Schätzungen und
eine Empfehlung; es kann **keine Risikolimits erhöhen** und **Live nie selbst aktivieren**.

## Modelle (nach jedem Trade neu angepasst)

| Modell | Methode | Verwendung |
|---|---|---|
| Ausführungswahrscheinlichkeit | logistische Regression (Newton/IRLS, L2), Features: Quote-Alter, Latenz, State-Alter, Brutto-bps, Screening-Spread, Größe, Hops, Volatilität; Beta-Prior (0,5) bis genug Daten | p im Erwartungswert |
| Spread-Decay / Slippage | realisierte vs. erwartete Abweichung je Venue-Folge, zum globalen Mittel geschrumpft; Streuung | erwartete Slippage, Sicherheitspuffer |
| Latenz | p75 der gemessenen Zeiten Entscheidung → Ausführung | Wartezeit im Paper, Feature |
| Routen-Zuverlässigkeit | Erfolgsquote je Route mit Beta-Prior | Sicherheitspuffer |
| Gebühren | bezahlte vs. prognostizierte Gebühren gelandeter Trades | Gate |
| Compute Units | p90 der simulierten/verbrauchten CU je Leg-Anzahl | Priority-Fee |

## Validierung

- **Chronologischer Split 60/20/20** (Kalibrierung / Validierung / Out-of-Sample) — nie gemischt,
  die Zukunft fließt nie ins Training.
- **Walk-Forward** mit wachsendem Fenster (`walkForwardFolds`, Standard 4).
- Kennzahlen je Abschnitt: Netto, Erwartungswert, Trefferquote, Fehlerquote, Max. Drawdown, p-Wert
  (einseitiger t-Test).
- Genauigkeiten: Ausführung = 1 − Brier-Score; Slippage = Anteil Prognosen innerhalb max(5 bps, 25 %);
  Gebühren = Anteil gelandeter Trades innerhalb 10 %.
- **Stabil**: Walk-Forward-Genauigkeiten schwanken um ≤ 0,15 und ≥ 75 % der Folds sind positiv.

## Live-Gate (Standardwerte, konfigurierbar)

≥ 5 000 Paper-Opportunities · ≥ 500 simulierte Ausführungen · ≥ 200 Latenzmessungen · Netto > 0 ·
Out-of-Sample- und Validierungs-Erwartungswert > 0 (je ≥ 20 Trades) · stabil · Genauigkeiten ≥ 80 % ·
Paper-Drawdown ≤ 1 € · Fehlerquote ≤ 30 %.

Besteht alles → **LIVE_READY** (Benachrichtigung). Das ist nur eine Empfehlung; der Mensch muss
„ENABLE LIVE TRADING“ bestätigen. Fällt das Gate wieder durch, geht der Zustand zurück auf
LIVE_LOCKED. Ist Live aktiv und der Status wird **DEGRADED** (OOS-Erwartungswert ≤ 0), schaltet der
Bot Live ab und kehrt zu Paper zurück.

## Learning-Score und Status

Score 0–100 = 35 % Datenmenge + 30 % Modellgenauigkeit + 20 % OOS-Kante + 15 % Stabilität.
Status: `COLLECTING_DATA` → `LEARNING` → `VALIDATING` → `LIVE_READY` (oder `DEGRADED`).

## Selbstoptimierung (nur Schwellen, nur strenger)

Der Optimizer (alle `optimizeIntervalMin`) testet ein Gitter **strengerer** Schwellen
(`minNetProfitEur`, `minNetProfitPercent`, `minExecutionProbability`, `safetyBufferBps`) — nur diese
Richtung ist mit den Daten ehrlich auswertbar, da nicht gehandelte Gelegenheiten kein Ergebnis haben.
Ein Kandidat wird nur übernommen, wenn er im Training besser, in der Validierung besser und
out-of-sample nicht schlechter ist. Jede Übernahme erzeugt eine neue **Strategie-Version**
(`strategy_vN`, Parameter unveränderlich gespeichert). Nach ≥ 30 Trades wird die aktive Version gegen
ihre Vorgängerin geprüft (negativer Erwartungswert bzw. signifikant schlechter, Welch-Test) →
**automatischer Rollback**.
