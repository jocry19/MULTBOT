# MULTBOT – Perpetual Signal Bot mit Paper-Trading

MULTBOT ist ein selbstlernender Signal-Bot für Perpetuals auf **Hyperliquid**. Er funktioniert auch mit den
HIP-3-Märkten des `xyz`-Dex (Aktien-Perps wie `xyz:GEV`). Er handelt **simuliert** mit **100 USD**
Startkapital und nutzt **immer den maximalen Hebel** des jeweiligen Marktes. Zur Bedienung gibt es ein
Terminal-Dashboard im Bloomberg-Stil.

> ⚠️ **Nur Simulation.** Der Bot liest ausschließlich öffentliche Marktdaten. Er signiert nichts und sendet
> keine echten Orders. Das ist keine Anlageberatung. Perps mit hohem Hebel auf dünnen Märkten können in Minuten
> liquidiert werden.

---

## App öffnen – per Doppelklick

Du brauchst keine Kommandozeile und musst vorher auch kein Python installieren:

| System | Starten |
|---|---|
| **Windows** | `MULTBOT.bat` doppelklicken |
| **macOS** | `MULTBOT.command` doppelklicken (beim ersten Mal: Rechtsklick → Öffnen) |
| **Linux** | `./start.sh` |

Beim ersten Start richtet sich alles selbst ein (1–3 Minuten, Internet nötig):

- Ein vorhandenes Python 3.10+ wird genutzt. Fehlt es, installiert das Skript Python automatisch über
  [uv](https://docs.astral.sh/uv/), das offizielle Tool von Astral. Dafür sind keine Admin-Rechte nötig,
  die Installation gilt nur für deinen Benutzer.
- Das Skript legt eine eigene Umgebung (`.venv`) an und installiert die Pakete.
- Auf dem Desktop erscheint ein **„MULTBOT“-Icon**. Damit startest du künftig.

Danach öffnet sich das Terminal als **eigenes App-Fenster** ohne Tabs und Adressleiste, sofern Chrome, Edge
oder Brave installiert ist. Sonst öffnet es sich im Standardbrowser. Das schwarze Konsolenfenster zeigt das Log.
Schließt du es, ist der Bot beendet.

Ein zweiter Doppelklick, während der Bot schon läuft, öffnet nur noch einmal das Terminal und startet keinen
zweiten Bot.

Windows zeigt bei Dateien aus dem Internet eventuell „Der Computer wurde durch Windows geschützt“. Klicke dann
auf „Weitere Informationen“ und „Trotzdem ausführen“. Neu aufsetzen: den Ordner `.venv` löschen und erneut
doppelklicken.

**Noch bequemer:**

- **Desktop-Verknüpfung mit Icon:** `python -m multbot shortcut` legt „MULTBOT“ auf den Desktop. Unter
  Windows ist das eine `.lnk`, unter macOS eine `.command`-Datei und unter Linux ein `.desktop`-Eintrag im
  Anwendungsmenü. Mit `shortcut --sim` entsteht eine Verknüpfung für die Simulation.
- **Als App installieren:** Im laufenden Terminal erscheint in Chrome oder Edge oben rechts der Knopf
  **⤓ APP** (alternativ über das Install-Symbol in der Adressleiste). Danach steht MULTBOT im
  Startmenü bzw. Dock und öffnet sich wie ein eigenes Programm. Der Bot selbst muss dafür laufen.
- **Auf dem Handy:** Starte mit `MULTBOT.bat run --lan` (oder `./start.sh run --lan`). Das Log zeigt dann
  eine Adresse wie `http://192.168.x.x:8050`. Öffne sie auf dem Handy im selben WLAN und lege sie über
  „Zum Startbildschirm hinzufügen“ ab. Achtung: Im WLAN kann dann jeder das Terminal öffnen und die
  Steuerung (Pause, Flat, Reset) benutzen. Es ist nur Papiergeld, aber nutze das trotzdem nur im eigenen Netz.
- **Simulation statt Live:** `MULTBOT.bat sim` bzw. `./start.sh sim`.

## Schnellstart (Kommandozeile)

```bash
pip install -r requirements.txt

python -m multbot markets      # Live-Tabelle deiner Märkte (Hebel, Mark, Funding, Volumen, OI, Gebühr)
python -m multbot run --app    # Live-Papierhandel, Terminal als App-Fenster (http://127.0.0.1:8050)
python -m multbot run --open   # dasselbe im normalen Browser-Tab
python -m multbot shortcut     # Desktop-Verknüpfung anlegen
python -m multbot research     # Walk-Forward-Backtest, Monte Carlo, Signal-Forschung
python -m multbot sim --open   # Offline-Simulation (synthetischer Markt im Zeitraffer)
python -m multbot report       # Kontoübersicht aus der Datenbank
```

Beim ersten Start von `run` lädt der Bot etwa 14 Tage 5-Minuten-Historie und das Funding. Er misst die
Kosten in den aktuellen Orderbüchern und trainiert den kompletten Lern-Stack mit einem Walk-Forward-Backtest
vor. Danach läuft er live über den Hyperliquid-WebSocket. Konto, Lernstand und Journal werden in `data/`
gespeichert. Ein Neustart macht an derselben Stelle weiter.

## Deine Märkte (config.yaml)

| Markt | Dex | Hebel |
|---|---|---|
| xyz:GEV, xyz:EBAY, xyz:SHEIN, xyz:LYTE, xyz:XBI, xyz:KSTR, xyz:BIRD | xyz (HIP-3) | 10x |
| xyz:OURA | xyz (HIP-3) | 5x |
| HMSTR, TNSR | main | 3x |

Märkte und Hebel stehen in `config.yaml`. Mit `leverage: max` nimmt der Bot automatisch das aktuelle
Börsenmaximum. Eine Zahl wird gegen das Maximum geprüft und notfalls gedeckelt. Alle anderen Parameter
(Risiko, Signale, Lernen, Ausführung) sind dort ebenfalls dokumentiert.

---

## Architektur

```
Hyperliquid WS/REST ─► Mark-Preis-Kerzen + Orderbuch + Trades + Funding/OI
                         │
                         ▼
             Feature-Pipeline (~60 Kennzahlen)  ──►  Regime (Trend/Range × Vola, Tradability)
                         │
                         ▼
        19 Strategien + Online-ML  ──►  Hedge-Ensemble (global × Regime × Markt)
                         │                         ▲
                         ▼                         │ lernt aus JEDER Meinung
             Meta-Modell P(Gewinn nach Kosten)     │ (auch ohne Trade)
                         │                         │
                         ▼                         │
   Risiko & Sizing (max. Hebel, Stop vor Liq) ──► Ausführungs-Simulator ──► Konto (Isolated Margin)
                                                                              │
                                                     SQLite · Journal · Lernkurve · Dashboard
```

| Modul | Inhalt |
|---|---|
| `exchange/` | Read-only-Client (REST mit Rate-Limiter, WebSocket mit Reconnect), Markt-Spezifikationen |
| `data/` | Kerzen-Puffer, Historie mit Disk-Cache, SQLite-Store |
| `features/` | Indikatoren, Statistik (Hurst, Varianz-Ratio, Kalman), Mikrostruktur, Regime |
| `strategies/` | 19 Strategien mit Begründungstexten |
| `learning/` | Hedge-Gewichte, Online-Logit, Beta-Posterior, EW-IC, Kalibrierung, Persistenz |
| `engine/` | Konto, Ausführung, Risiko, Entscheidungs-Engine, Live-/Sim-Runner, synthetischer Markt |
| `research/` | Walk-Forward-Backtest, Kennzahlen, Monte Carlo, Report |
| `web/` | Starlette-Server und Terminal-Frontend (eigene Canvas-Charts, keine CDN-Abhängigkeit) |

### Simulations-Mechanik (wie Hyperliquid)

- **Hebel:** immer der Maximalhebel. Initial-Margin = Notional / Hebel.
- **Maintenance-Margin:** die Hälfte der Initial-Margin beim Maximalhebel, also 5 % bei 10x und 16,7 % bei 3x.
- **Liquidationspreis** (Formel aus den HL-Docs):
  `liq = entry − side · margin / size / (1 − side · mm)`.
  Bei 10x Long liegt die Liquidation etwa 5,26 % unter dem Einstieg, bei 3x etwa 20 %.
- **Isolated Margin:** Der Verlust ist auf die Margin der Position begrenzt. Funding wird stündlich mit der
  Margin verrechnet, dadurch wandert der Liquidationspreis mit.
- **Gebühren** kommen live aus der Meta. Tier 0 kostet 0,045 % Taker und 0,015 % Maker. HIP-3-Märkte mit
  Deployer-Fee-Scale 1.0 kosten das Doppelte. Der Growth-Mode zieht davon 90 % ab. Für deine
  `xyz`-Märkte ergibt das 0,009 % Taker.
- **Ausführung:**
  - Taker-Orders laufen durch das echte L2-Buch (VWAP über die Level). Wo das Buch nicht reicht, gibt es
    einen Aufschlag.
  - Maker-Einstiege (Standard) setzen ein Limit am Best-Bid bzw. Best-Ask. Gefüllt wird nur, wenn der Markt
    *durch* den Preis handelt. So bildet die Simulation Adverse Selection realistisch ab.
  - Take-Profit ist eine ruhende Limit-Order.
- **Stops** liegen immer vor dem Liquidationspreis, bei höchstens 60 % der Distanz. Ab +1R wird nachgezogen
  (Trailing auf mindestens Break-even). Dazu kommen ein Zeit-Stop und ein Ausstieg bei Signalumkehr.
- **Ruin:** Fällt das Equity unter 5 USD, beginnt eine neue *Epoche* mit 100 USD. Der Lernstand bleibt.

### Lernen

Der Bot bewertet jede Strategie auf jedem Markt in jedem Takt, nicht nur bei echten Trades. Nach dem
Lern-Horizont (Standard 3 Bars = 15 min) passiert Folgendes:

1. **Hedge / Multiplicative Weights** in drei Ebenen (global, je Regime, je Markt) mit Vergessensfaktor.
   Daraus entsteht das Ensemble.
2. Der **Beta-Posterior** der Trefferquote jeder Strategie wird aktualisiert. Ist eine Strategie belastbar
   schlechter als 50 %, wird sie **stummgeschaltet**. Sobald sie sich erholt, ist sie wieder aktiv.
3. Ein **Online-Logit (AdaGrad, L2)** über ~40 standardisierte Features sagt die Richtung voraus.
4. Ein **Meta-Label-Modell** lernt aus Kandidaten und echten Trades, ob ein Signal *nach Kosten* gewinnt.
   Es filtert die Trades und skaliert die Margin.
5. Weitere Diagnosen:
   - Information Coefficient je Strategie × Horizont (Signal-Zerfall), × Regime und × Markt
   - Feature-IC
   - Kalibrierungsdiagramme
   - Lernkurve

### Forschung (`python -m multbot research` oder F6 im Terminal)

- Walk-Forward: Die ersten 40 % der Historie werden nur gelernt. Der Rest wird out-of-sample gehandelt,
  das Lernen läuft dabei weiter. Der Backtest nutzt dieselbe Engine wie live.
- Die Kosten werden in den aktuellen Orderbüchern kalibriert (Spread, Tiefe ±2 %).
- Kennzahlen:
  - Sharpe, Sortino, Calmar, Max-DD, VaR/CVaR
  - Profit-Faktor, Ø R, Verlustserien
  - Ergebnisse je Markt, je Regime und je Stunde
- Ein **Monte-Carlo-Bootstrap** der Trade-Renditen liefert P(Ruin), P(Gewinn), Perzentile, einen
  Fan-Chart und einen Kelly-Faktor.
- Marktstruktur: Volatilität, Anteil eingefrorener Bars, Kurtosis, Funding p.a., Korrelationen.

> **Ehrlicher Hinweis:** Die historischen Kerzen von Hyperliquid sind *Trade*-Preise. In dünnen Märkten
> springen sie zwischen Bid und Ask hin und her. Mean-Reversion sieht im Backtest deshalb besser aus, als sie
> nach Kosten ist, und Stops werden öfter getroffen. Live baut der Bot seine Kerzen aus dem **Mark-Preis**,
> den Hyperliquid auch für Liquidationen nutzt.
>
> Die `xyz`-Aktien-Perps folgen außerdem den US-Börsenzeiten. Außerhalb der Session (Wochenende, Nacht) ist
> das Oracle eingefroren. Der Bot sperrt dann neue Einstiege und protokolliert den Grund.

---

## Terminal (Dashboard)

Bedienung über die Kommandozeile oben rechts, im Bloomberg-Stil: `GEV <GO>`, `LRN`, `RES` und so weiter.
Die Seiten erreichst du auch über F1–F10.

| Taste | Seite | Inhalt |
|---|---|---|
| F1 | MONITOR | Marktübersicht, Konto, Equity-Kurve, Positionen, Signal-Heatmap, Journal |
| F2 | ASSET | Candle-Chart (EMA, Bollinger, Kalman, VWAP, Entry/Stop/TP/Liq-Linien), Live-Orderbuch, Ensemble-Score, Strategie-Stimmen mit Begründung, Features, Liquidations-Mechanik |
| F3 | SIGNALE | Matrix aller Strategien × Märkte, Ablehnungsgründe („warum nicht gehandelt?“), Gewichte |
| F4 | LERNEN | Lernkurve, Gewichts-Evolution, Strategie-Labor (Posterior, KI, IC, t-Wert, Schatten-PnL), Signal-Zerfall, Feature-IC, IC je Regime/Markt, Kalibrierung, ML- und Meta-Gewichte |
| F5 | RISIKO | Liquidationsabstände, Stresstest (±2…20 %), Exposure, VaR, Drawdown, Korrelationsmatrix, Regeln |
| F6 | FORSCHUNG | Research-Lauf per Knopf, OOS-Kennzahlen, Backtest-Equity, Monte Carlo, Verteilungen, Marktstruktur |
| F7 | BLOTTER | Alle Trades. Ein Klick zeigt die vollständige Entscheidungsbegründung. |
| F8 | JOURNAL | Jede Entscheidung (Entry, Exit, Order, Cancel, Skip, Funding, Ruin) mit Filter und Suche |
| F9 | SYSTEM | Feed-Status, Steuerung (Pause, Fortsetzen, Flat, Reset), Markt-Spezifikationen, Kosten-Kalibrierung, Konfiguration |
| F10 | HILFE | Kommandos und Methodik |

Kommandos: `PAUSE`, `RESUME`, `FLAT [GEV]`, `RESET`, `RUN RES`, `<MARKT> <GO>`.

---

## Tests

```bash
python -m pytest -q
```

Die Tests prüfen:

- die Liquidationsformel gegen die HL-Formel und den Maintenance-Punkt
- die Gebühren-Multiplikatoren
- Book-Walk-Fills
- dass der Stop immer vor dem Liquidationspreis liegt
- die Lernalgorithmen
- dass die Features kausal sind (kein Look-ahead)
- die Grenzen der Strategie-Scores
- den End-to-End-Backtest mit Buchhaltungs-Identität
- die Persistenz
