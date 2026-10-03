# Trading-Engine

## Ablauf pro Scan (alle `poolPollMs`, Standard 2 s)

1. **Pool-State lesen** — alle verfolgten Pools + Vaults/Configs in gebündelten
   `getMultipleAccounts`-Aufrufen (≤ 100 Accounts pro Request), dekodiert zu Marginalpreisen mit Slot.
2. **Screening** — direkte und trianguläre Routen; nur Routen mit Spread *nach Pool-Gebühren*
   ≥ `screenMinSpreadBps` werden Kandidaten. Alle anderen werden pro Minute als
   `SPREAD_TOO_SMALL` gezählt („WHY NO TRADE?“).
3. **Kandidaten-Queue** — bester Spread zuerst, Cooldown je Route, Limit pro Minute
   (`maxCandidatesPerMinute`), exponentielles Backoff für Routen, deren Firm-Quotes dem Screening
   widersprechen (typisch: DLMM-Active-Bin ohne Tiefe).
4. **Bewertung** (`OpportunityEvaluator`) — Probe-Quotes bei mittlerer Ladder-Größe, Impact-Modell,
   ganze Ladder mit vollem Kostenmodell, beste Größe erneut **firm** gequotet, Urteil.
5. **Persistenz** — jede bewertete Opportunity wird gespeichert, auch jede abgelehnte, mit Grund,
   Kosten-Wasserfall, Ladder, Legs und Features.
6. **Risk-Gate** — `RiskEngine.validate()`; nur mit Freigabe geht es weiter.
7. **Ausführung** — Paper/Shadow (`PaperExecutor`) oder Live (`LiveExecutor`).
8. **Learning** — nach jedem Trade werden die Modelle neu angepasst.

## Kostenmodell (`calculateNetProfit`)

```
gross          = Output der verketteten Firm-Quotes − Input     (DEX-Gebühren + Impact bereits enthalten)
netIfSuccess   = gross − erwartete Slippage − Basisgebühr − Priority-Fee − Jito-Tip
expectedValue  = p × netIfSuccess − (1 − p) × Fehlschlagkosten
usableEdge     = expectedValue − Sicherheitspuffer
```

- DEX-Gebühren und Price Impact werden zur Erklärung aus dem Mid-Spread zerlegt, aber **nicht
  doppelt** abgezogen — sie stecken bereits im Quote-Output.
- **Fehlschlagkosten**: per Jito-Bundle 0 (ein revertierendes Bundle wird nicht aufgenommen); per
  RPC-Transaktion Basis- + Priority-Fee.
- **Jito-Tip ist immer echte Kosten.** Wenn die Kante nur vor dem Tip existiert → `JITO_TOO_EXPENSIVE`.
- **Sicherheitspuffer** (dynamisch): Basis-bps + gelernte Slippage-Unsicherheit + Quote-Alter +
  (1 − Routen-Zuverlässigkeit) × 10 bps (+ Aufschlag für nicht-atomare Routen, standardmäßig verboten).
- **Priority-Fee**: Markt-Perzentil aus `getRecentPrioritizationFees`, für wertvolle Gelegenheiten
  um bis zu +25 Perzentilpunkte erhöht, gedeckelt durch Limit und Gewinnanteil — nie „Maximum“.
- **Compute Units**: aus Simulationen gelernt (p90 × 1,1), live aus der Simulation der echten
  Transaktion (+10 % + 10 000).

## Entscheidung (`judgeEdge`) — NO NET EDGE = NO TRADE

Die erste Kostenschicht, die die Kante zerstört, wird zum Ablehnungsgrund:

`SPREAD_TOO_SMALL` → `PRICE_IMPACT_TOO_HIGH` → `FEES_TOO_HIGH` → `SLIPPAGE_TOO_HIGH` →
`PRIORITY_FEE_TOO_HIGH` → `JITO_TOO_EXPENSIVE` → `EXECUTION_PROBABILITY_TOO_LOW` →
`NET_PROFIT_BELOW_THRESHOLD`.

Dazu kommen aus anderen Stufen: `QUOTE_TOO_OLD`, `ROUTE_UNAVAILABLE`, `QUOTE_BUDGET_EXHAUSTED`,
`RISK_LIMIT`, `DAILY_LOSS_LIMIT`, `CONCURRENCY_LIMIT`, `WALLET_RESERVE`, `TOKEN_REJECTED`,
`NOT_ATOMIC`, `CIRCUIT_BREAKER`, `BOT_NOT_TRADING`, `SIMULATION_FAILED`, `OPPORTUNITY_VANISHED`.

## Erklärung im Dashboard

Jede Opportunity hat eine Detailseite „Warum will der Bot diesen Trade machen?“: Route, Mid-Spread,
Firm-Quote-Ergebnis, jeder Kostenposten in bps und EUR, Ausführungswahrscheinlichkeit, Sicherheitspuffer,
nutzbare Kante, Entscheidung mit Grund — ausschließlich aus den gespeicherten Zahlen.
