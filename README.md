# MULT Q2 – Perpetual Signal Bot mit Paper-Trading

MULT Q2 (Version 2.0, Nachfolger von MULTBOT) ist ein selbstlernender Signal-Bot für Perpetuals auf **Hyperliquid**. Er funktioniert auch mit den
HIP-3-Märkten des `xyz`-Dex (Aktien-Perps wie `xyz:GEV`). Er handelt **simuliert**, und **jede Position
hat 100 USD Margin** beim **maximalen Hebel** des jeweiligen Marktes. Das Kapital ist unbegrenzt, es dürfen
**beliebig viele Positionen** offen sein, und gemessen wird der **PnL in USD**. Damit der Bot dabei keine
unnötigen schlechteren Trades nimmt, rankt er die Kandidaten jeder Bar über alle Märkte nach **erwarteter
Rendite auf die Margin** (erwartete Bewegung × Hebel − Kosten × Hebel) und nimmt nur Trades, die nach Kosten
im Plus erwartet werden. Zur Bedienung gibt es ein Terminal-Dashboard im Bloomberg-Stil.

## Neu in MULT Q2

- **Alpha-Labor (F11, `python -m multbot lab`).** Das Labor prüft rund 90 vorab festgelegte Strategie-Hypothesen
  auf ≈ 208 Tagen Stunden-Historie der liquidesten Märkte:
  - Momentum, Reversion, Querschnitt, Residual-Reversion, Funding-Carry, Prämie, Effekte bei Aktien-Perps und
    der Markt-Trend als Referenz.
  - Jede Hypothese wird nach echten Kosten (Gebühren, Markteinfluss, Funding) in zwei Zeithälften gerechnet,
    einmal als reines Signal und einmal als echter Bot-Trade mit Maximalhebel und Stop vor der Liquidation.
  - Das Labor sagt ehrlich, wie viele Treffer allein durch Zufall zu erwarten wären.
- **Realistischere Simulation** nach einem vollständigen Code-Audit mit 13 behobenen Fehlern:
  - Maker-Orders füllen live nur noch durch Trades *nach* der Platzierung, die durch das Limit gehen, oder
    wenn das Volumen am Limit die Warteschlange davor plus die eigene Größe übersteigt.
  - Die Kostenschätzung enthält den Markteinfluss. Vorher wurden dünne Orderbücher im Ranking bevorzugt.
  - Take-Profit muss durchgehandelt werden. Der Break-even-Stop deckt die Gebühren.
  - Kein doppelter Bar-Abschluss nach Standby. Funding wird pro Stunde mit dem Satz der abgelaufenen Stunde
    verrechnet. Ein Fehler in einem Markt stoppt nicht mehr den ganzen Takt.
  - Backtests schneiden keine Trades mehr ab. Kennzahlen im Modus `fixed` sind additiv in USD.
- **Schneller:** Das Lernmodul ist vektorisiert (numpy). Backtests und der Live-Betrieb mit 289 Märkten
  brauchen ≈ 30 % weniger CPU.
- **Komfort:**
  - Version im Terminal
  - CSV-Export aller Trades (BLOTTER)
  - Übernahme von Konto und Positionen aus dem alten MULTBOT-Ordner
  - neue Launcher `MULT-Q2.bat` / `MULT-Q2.command`

> ⚠️ **Nur Simulation.** Der Bot liest ausschließlich öffentliche Marktdaten. Er signiert nichts und sendet
> keine echten Orders. Das ist keine Anlageberatung. Perps mit hohem Hebel auf dünnen Märkten können in Minuten
> liquidiert werden.

---

## App öffnen – per Doppelklick

Du brauchst keine Kommandozeile und musst vorher auch kein Python installieren:

| System | Starten |
|---|---|
| **Windows** | `MULT-Q2.bat` doppelklicken |
| **macOS** | `MULT-Q2.command` doppelklicken (beim ersten Mal: Rechtsklick → Öffnen) |
| **Linux** | `./start.sh` |

Beim ersten Start richtet sich alles selbst ein (1–3 Minuten, Internet nötig):

- Ein vorhandenes Python 3.10+ wird genutzt. Fehlt es, installiert das Skript Python automatisch über
  [uv](https://docs.astral.sh/uv/), das offizielle Tool von Astral. Dafür sind keine Admin-Rechte nötig,
  die Installation gilt nur für deinen Benutzer.
- Das Skript legt eine eigene Umgebung (`.venv`) an und installiert die Pakete.
- Auf dem Desktop erscheint ein **„MULT Q2“-Icon**. Damit startest du künftig.
- **Update von MULTBOT:** Den neuen Ordner neben den alten `MULTBOT`-Ordner legen. Beim ersten Start übernimmt
  MULT Q2 automatisch Konto, offene Positionen und Trades aus `../MULTBOT/data` (der alte Ordner bleibt
  unverändert). Das alte „MULTBOT“-Icon auf dem Desktop kannst du danach löschen.

Danach öffnet sich das Terminal als **eigenes App-Fenster** ohne Tabs und Adressleiste, sofern Chrome, Edge
oder Brave installiert ist. Sonst öffnet es sich im Standardbrowser. Das schwarze Konsolenfenster zeigt das Log.
Schließt du es, ist der Bot beendet.

Ein zweiter Doppelklick, während der Bot schon läuft, öffnet nur noch einmal das Terminal und startet keinen
zweiten Bot.

Windows zeigt bei Dateien aus dem Internet eventuell „Der Computer wurde durch Windows geschützt“. Klicke dann
auf „Weitere Informationen“ und „Trotzdem ausführen“. Neu aufsetzen: den Ordner `.venv` löschen und erneut
doppelklicken.

**Noch bequemer:**

- **Desktop-Verknüpfung mit Icon:** `python -m multbot shortcut` legt „MULT Q2“ auf den Desktop. Unter
  Windows ist das eine `.lnk`, unter macOS eine `.command`-Datei und unter Linux ein `.desktop`-Eintrag im
  Anwendungsmenü. Mit `shortcut --sim` entsteht eine Verknüpfung für die Simulation.
- **Als App installieren:** Im laufenden Terminal erscheint in Chrome oder Edge oben rechts der Knopf
  **⤓ APP** (alternativ über das Install-Symbol in der Adressleiste). Danach steht MULT Q2 im
  Startmenü bzw. Dock und öffnet sich wie ein eigenes Programm. Der Bot selbst muss dafür laufen.
- **Auf dem Handy:** Starte mit `MULT-Q2.bat run --lan` (oder `./start.sh run --lan`). Das Log zeigt dann
  eine Adresse wie `http://192.168.x.x:8050`. Öffne sie auf dem Handy im selben WLAN und lege sie über
  „Zum Startbildschirm hinzufügen“ ab. Achtung: Im WLAN kann dann jeder das Terminal öffnen und die
  Steuerung (Pause, Flat, Reset) benutzen. Es ist nur Papiergeld, aber nutze das trotzdem nur im eigenen Netz.
- **Simulation statt Live:** `MULT-Q2.bat sim` bzw. `./start.sh sim`.

## Schnellstart (Kommandozeile)

```bash
pip install -r requirements.txt

python -m multbot markets      # Live-Tabelle deiner Märkte (Hebel, Mark, Funding, Volumen, OI, Gebühr)
python -m multbot run --app    # Live-Papierhandel, Terminal als App-Fenster (http://127.0.0.1:8050)
python -m multbot run --open   # dasselbe im normalen Browser-Tab
python -m multbot shortcut     # Desktop-Verknüpfung anlegen
python -m multbot research     # Walk-Forward-Backtest auf den 40 volumenstärksten Märkten
python -m multbot research --top 0              # … auf allen Märkten (dauert beim ersten Mal lange)
python -m multbot research --coins BTC,ETH,xyz:TSLA
python -m multbot lab          # Alpha-Labor: alle Signal-Familien nach Kosten (≈208 Tage Stunden-Historie)
python -m multbot sim --open --markets 30       # Offline-Simulation (synthetischer Markt im Zeitraffer)
python -m multbot report       # Kontoübersicht aus der Datenbank
```

Beim Start von `run` ist das Terminal sofort da, und der WebSocket läuft ab der ersten Sekunde. Die Historie
(600 Kerzen je Markt) lädt der Bot im Hintergrund, nach Priorität: offene Positionen zuerst, dann nach
24h-Volumen. Jeder Markt wird nach dem Laden einzeln vortrainiert und ist dann „bereit“. Bei 289 Märkten
dauert das beim ersten Start einige Minuten, danach nur Sekunden, weil die Historie zwischengespeichert wird.
Konto, Lernstand und Journal liegen in `data/`. Ein Neustart macht an derselben Stelle weiter.

## Deine Märkte (config.yaml)

**289 Märkte**, alle live gegen die Hyperliquid-Meta geprüft. Jeder handelt mit dem Börsenmaximum als Hebel
(3x–50x), und deine Hebel-Angaben stimmen alle mit dem Maximum überein.

| Gruppe | Anzahl | Beispiele | Hebel |
|---|---|---|---|
| Krypto (Hyperliquid main) | 178 | BTC 40x, ETH 25x, SOL/XRP 20x, HYPE 10x, … | 3x–40x |
| Aktien & ETFs (`xyz`) | 95 | TSLA, NVDA, MU, SNDK, AAPL, SOXL, EWY, … | 5x–20x |
| Indizes (`xyz`) | 4 | SP500 50x, XYZ100 30x, JP225, KR200 | 20x–50x |
| Rohstoffe (`xyz`) | 9 | GOLD, SILVER, CL, BRENTOIL, NATGAS, COPPER, … | 10x–25x |
| FX (`xyz`) | 3 | EUR, JPY, GBP | 50x |

In `config.yaml` steht einfach eine Liste (`- BTC`, `- xyz:TSLA`). `default_leverage: max` gilt für alle
Märkte, einzelne können abweichen (`- { coin: "BTC", leverage: 20 }`). Unbekannte oder delistete Märkte
werden beim Start übersprungen und gemeldet. Mit `universe.min_day_volume_usd` und
`universe.max_markets` kannst du das Universum verkleinern.

**So bleibt der Bot bei ~290 Märkten schnell und innerhalb der Hyperliquid-Limits** (1200 Gewicht/min REST,
1000 WebSocket-Abos):

- Mark-Preis, Funding, OI und Trades kommen per WebSocket für alle Märkte.
- Orderbücher abonniert er nur für die **40 Fokus-Märkte**: Positionen, Orders, die stärksten Signale und
  den Markt, der gerade im Terminal offen ist. Zusammen sind das etwa 620 Abos.
- Hat ein starkes Signal noch kein Live-Buch, abonniert der Bot es zuerst und steigt ein, sobald das echte
  Orderbuch da ist.
- Kerzenschlüsse für alle Märkte werden gestaffelt verarbeitet. Der Rate-Limiter zählt auch das
  Zusatzgewicht großer Abfragen mit.

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
- **Stops** liegen immer vor dem Liquidationspreis, bei höchstens 60 % der Distanz und mindestens 0,4 %
  entfernt. Ab +1R wird nachgezogen (Trailing auf mindestens Break-even). Dazu kommen ein Zeit-Stop und ein
  Ausstieg bei Signalumkehr.
- **Klumpenrisiko:** höchstens 3 Positionen je Asset-Klasse und Richtung, also z. B. nicht sechs
  Tech-Aktien-Longs auf einmal. Zusätzlich sperrt eine Korrelationsgrenze (0,75), die sofort aus der
  geladenen Historie berechnet wird.
- **Kapitalmodell `fixed` (Standard):**
  - Jede Position bekommt genau `position_margin_usd` (100 USD) Margin × Maximalhebel. Bei 10x sind das
    1.000 USD, bei BTC mit 40x 4.000 USD Positionsgröße.
  - Es dürfen beliebig viele Positionen offen sein (`risk.max_open_positions: null`; eine Zahl setzt wieder
    ein Limit). Das Kapital ist unbegrenzt, der Kontostand limitiert also nie, und es gibt keinen Ruin.
  - Gezeigt werden PnL gesamt (realisiert + offen), Ø pro Trade, Ø ROE auf die 100 USD, Trefferquote,
    Profit-Faktor und Max-Drawdown in USD. Prozentwerte beziehen sich auf ein Referenzkapital von
    10 × 100 = 1.000 USD (`account.reference_capital_usd`). Es ändert keinen Trade.
  - Reicht ein Orderbuch nicht für die volle 100-USD-Position, wird der Trade übersprungen statt verkleinert.
    So bleibt jede Position vergleichbar.
- **Ranking nach erwarteter Rendite** (`signal.rank_entries`):
  - Der Bot sammelt die Einstiegs-Kandidaten einer Bar über alle Märkte, bevor er handelt.
  - Für jeden schätzt er die erwartete Bewegung in Signalrichtung. Sie wird gelernt aus dem, was Kandidaten mit
    gleicher Signalstärke und Volatilität danach tatsächlich gemacht haben (Tabelle im Terminal unter LRN).
  - Daraus wird **E[ROE] = Hebel × (erwartete Bewegung − Kosten)**. Die Kosten umfassen Gebühren, halben
    Spread und Funding.
  - Eingestiegen wird bestmöglich zuerst. So bekommen bei Klumpen- und Korrelationsgrenzen immer die
    besseren Trades den Platz.
  - Trades unter `min_exp_roe` (Standard 0, also nicht nach Kosten im Plus erwartet) werden übersprungen.
  - Mit `max_new_per_bar` lässt sich zusätzlich begrenzen, wie viele neue Positionen je Bar entstehen.
  - Im Journal, bei Orders und Trades steht jeweils E[ROE] und der Rang, z. B. „E[ROE] +1,2 % · Rang 1/14“.
- **Kapitalmodell `compounding` (optional):** ein einziges Konto mit Startkapital, das wächst oder schrumpft.
  Bei Totalverlust beginnt eine neue *Epoche*, der Lernstand bleibt.

### Lernen

Der Bot bewertet jede Strategie auf jedem Markt in jedem Takt, nicht nur bei echten Trades. Nach dem
Lern-Horizont (Standard 12 Bars = 1 h) passiert Folgendes:

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
- Ein **Monte-Carlo-Bootstrap** der Trades liefert P(Gewinn), PnL-Perzentile, Max-Drawdown (im Modus `fixed`
  addiert sich der PnL bei fester Positionsgröße), einen
  Fan-Chart und einen Kelly-Faktor.
- Marktstruktur: Volatilität, Anteil eingefrorener Bars, Kurtosis, Funding p.a., Korrelationen.

> **Ehrlicher Hinweis:** Die historischen Kerzen von Hyperliquid sind *Trade*-Preise. In dünnen Märkten
> springen sie zwischen Bid und Ask hin und her. Mean-Reversion sieht im Backtest deshalb besser aus, als sie
> nach Kosten ist, und Stops werden öfter getroffen. Live baut der Bot seine Kerzen aus dem **Mark-Preis**,
> den Hyperliquid auch für Liquidationen nutzt.
>
> **Handelszeiten werden gelernt, nicht vorgegeben.** Deine Märkte folgen ganz unterschiedlichen Börsen:
> US-Aktien, koreanische (SKHX, SMSN, HYUNDAI), japanische (KIOXIA, SOFTBANK) und chinesische (ZHIPU,
> MINIMAX, UNITREE) Titel, Rohstoffe und FX (24/5), dazu Krypto (24/7).
>
> - Das Feature `session` lernt für jeden Markt aus den Daten, zu welcher Tageszeit (werktags/Wochenende)
>   er aktiv ist.
> - Live sperrt der Bot neue Einstiege, wenn sich das Oracle seit 20 Minuten nicht bewegt hat, die Börse
>   des Basiswerts also geschlossen ist. Den Grund schreibt er ins Journal.

### Profitabilität: was der Walk-Forward-Test zeigt

Die Standardwerte in `config.yaml` sind nicht geschätzt. Sie wurden per Walk-Forward mit unberührtem
Holdout ausgewählt, und zwar mit genau dem Modell, das live läuft: 100 USD Margin × Maximalhebel je
Position, Maker-Einstiege, echtes Funding, Spreads aus den aktuellen Orderbüchern. Die folgende Tabelle wurde
noch mit höchstens 5 offenen Positionen ermittelt. Zum Ranking siehe weiter unten.

- **Daten:** die 60 liquidesten Märkte (33 Krypto, 18 Aktien, 4 Rohstoffe, 3 ETFs, 2 Indizes).
  - 5m-Kerzen über 14 Tage (5.–19. Okt. 2026)
  - 15m-Kerzen über 52 Tage (28. Aug.–19. Okt. 2026)
- **Ablauf:**
  - 0–40 % der Zeit wird nur gelernt.
  - 40–70 % ist die **Validierung**. Nur danach wird ausgewählt.
  - 70–100 % ist der **Holdout**. Er wird nur berichtet.
- **Regel:** Eine Änderung wird nur übernommen, wenn sie in Validierung *und* Holdout hilft und auf der
  anderen Datenbasis nicht schadet.

| Änderung | Validierung | Holdout | Entscheidung |
|---|---|---|---|
| Lern-Horizont 1 h statt 15 min | +300 USD | +120 USD | **übernommen** (`horizon: 12`) |
| Tages-Verlustpause aus | ±0 | +81 USD | **übernommen** (`daily_loss_pause_pct: 0`) |
| Lead-Lag ggü. BTC / XYZ100 | −236 USD | −205 USD | aus (auf 15m ebenfalls schlechter) |
| Markt-/Regime-Gates (IC ≥ 0) | −60 USD | −147 USD | aus (auf 15m ebenfalls schlechter) |
| P(Gewinn) ≥ 0,55 / 0,56 | −98 / −130 USD | −18 / −225 USD | bleibt 0,53 |
| Take-Profit 3R statt 2,2R | −22 USD | −77 USD | bleibt 2,2R |
| kein Ausstieg bei Signalumkehr | −27 USD | ±0 | Ausstieg bleibt (auf 15m klar schlechter) |
| reiner Zeit-Ausstieg, Einstiegsschwelle 0,20, Vola-Stops | gemischt | gemischt | nicht übernommen |
| 15m- statt 5m-Takt | – | – | 5m bleibt (15m über 52 Tage: −113 / −33 USD) |

Die Werte sind PnL-Differenzen der gesamten Strategie im jeweiligen Fenster, mit je etwa 200–300 Trades.

**Ergebnis mit den neuen Standardwerten (5m):**

- Validierung: **+61 USD** aus 285 Trades (Profit-Faktor 1,06, Ø +0,21 USD je Trade)
- Holdout: **+45 USD** aus 249 Trades (Profit-Faktor 1,04, Ø +0,18 USD je Trade)
- Die alten Standardwerte lagen im selben Test bei −213 USD bzw. −22 USD.

> **Ehrlich:** Das ist eine klare Verbesserung, aber **kein Beweis für einen profitablen Bot**.
>
> - Der Standardfehler liegt bei ±150–170 USD je Fenster. Die Ergebnisse sind statistisch also nicht von
>   null zu unterscheiden.
> - Über die längere 15m-Historie bleibt das Ergebnis leicht negativ.
> - Hauptgegner sind die **Gebühren**. Bei 100 USD Margin und 10–40x Hebel kostet jeder Trade
>   ungefähr so viel, wie die Signale im Mittel brutto verdienen. In der Einzeltrade-Analyse lagen die
>   Trades brutto bei +224 USD, davon gingen 198 USD an Gebühren und 13 USD an Funding.
> - Die meisten Verluste entstehen durch Stops in den ersten 30 Minuten nach dem Einstieg.
>
> Der Bot lernt live weiter (Gewichte, ML- und Meta-Modell, IC je Markt). Ob daraus eine echte Kante wird,
> zeigen erst Wochen Papierhandel. Verfolgen kannst du das im Terminal unter BRAIN und RESEARCH.

**Unbegrenzte Positionen mit Ranking im selben Test** (PnL in USD, Validierung / Holdout, in Klammern Trades):

| Variante | 5m (14 Tage) | 15m (52 Tage) |
|---|---|---|
| max. 5 offen, ohne Ranking (vorher) | +61 / +45 (285 / 249) | −113 / −33 (254 / 166) |
| unbegrenzt, gerankt, ohne Mindestwert | −89 / −170 (438 / 345) | +25 / −136 (337 / 201) |
| **unbegrenzt, gerankt, E[ROE] ≥ 0 (Standard)** | −88 / −263 (132 / 190) | +21 / −39 (28 / 43) |

Max-Drawdown mit Standardwerten: 226 / 461 USD auf 5m und 72 / 115 USD auf 15m. Ohne Mindestwert waren es
287 / 553 und 745 / 276 USD.

Ebenfalls getestet und nicht besser: Ranking mit Limit 5, E[ROE] ≥ −0,5 % bzw. ≥ +0,5 %, höchstens 3 neue
Positionen je Bar, Limit 10.

> **Ehrlich:**
>
> - **Das erste Modell war falsch herum.** Die erwartete Bewegung als „Signalstärke × Volatilität“ zu
>   schätzen, war die naheliegende Idee. Die Trades mit der höchsten Erwartung verloren aber am meisten
>   (oberste 20 %: Ø −2,41 USD je Trade). Die stärksten Signale und die volatilsten Märkte laufen
>   anschließend eher zurück. Das Ranking nutzt deshalb jetzt eine gelernte Tabelle. Sie bildet das ab und
>   sortiert im Holdout in die richtige Richtung.
> - **Mehr Positionen sind nicht mehr Gewinn.** Ohne Limit nimmt der Bot mehr Trades von ähnlicher oder
>   schlechterer Qualität, und die Kosten wachsen mit. Im Test lag das alte Limit von 5 insgesamt etwa
>   330 USD vorn.
> - **Was die Mindesterwartung bringt:** E[ROE] ≥ 0 erfüllt das Ziel „keine unnötigen schlechteren
>   Positionen“ nur teilweise. Der Bot nimmt 60–90 % weniger Trades mit kleinerem Drawdown. Im Mittel
>   gewinnt er pro Trade aber nicht mehr. Die Signale geben schlicht zu wenig her, um gute von schlechten
>   Trades zuverlässig zu trennen.
> - **Wieder zum Limit:** `risk.max_open_positions: 5` setzen. Ranking und Mindesterwartung bleiben dabei
>   aktiv.
> - **Gefundener Fehler:** Das Live-Vortraining lernt Markt für Markt. Ein später gelernter Markt profitierte
>   dadurch schon von dem, was das Modell auf anderen Märkten im selben Zeitraum gesehen hatte. Die gelernte
>   Bewegung war deshalb etwa zehnfach überschätzt. Die Tabelle lernt jetzt nur aus sauberen Live-Daten und
>   startet mit vorsichtigen 2,5 bps je Stunde. Die Backtests waren nicht betroffen, sie laufen zeitlich
>   verschränkt.

---

## Terminal (Dashboard)

Bedienung über die Kommandozeile oben rechts, im Bloomberg-Stil: `GEV <GO>`, `LRN`, `RES` und so weiter.
Die Seiten erreichst du auch über F1–F11.

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
| F11 | ALPHA-LABOR | alle Signal-Familien nach echten Kosten in zwei Zeithälften; reines Signal und echter Maximalhebel-Trade; ehrlicher Zufalls-Vergleich (`LAB <GO>`) |

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
