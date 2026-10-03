# Risiko

## RiskEngine.validate() — nicht umgehbar

Jede Ausführung (Paper und Live) braucht eine **RiskApproval**, die nur `validate()` ausstellt:
einmalig verwendbar, an Opportunity-ID, Modus und einen Fingerabdruck (Mengen, Gebühren, Tip,
Mindest-Outputs, Route) gebunden und gültig nur bis die Quote zu alt würde. Paper- und Live-Executor
verbrauchen die Freigabe und verweigern sonst.

Prüfungen: Modus · Notstopp · Bot-Zustand · Live: `LIVE_MODE` + Gate `LIVE_ENABLED` · offene Breaker ·
Quote-Frische · Firm-Quotes für alle Legs · Token-Sicherheit · Atomarität · Leg-Slippage · Price
Impact · Priority-Fee- und Tip-Limit · **positive Nettokante** · Ausführungswahrscheinlichkeit ·
Größe ≤ Obergrenze · Concurrency · Reserve · Worst-Case-Verlust ≤ 0,30 € · Tageslimit ·
Fehlschläge in Folge.

**Worst-Case-Verlust**: atomar via Jito = Tip (konservativ); atomar via RPC = Gebühren + Tip;
nicht-atomar (standardmäßig verboten) = Größe × (Slippage + Puffer + 5 % Inventarrisiko) + Gebühren.

## Größen-Obergrenze

Minimum aus: Benutzer-Maximum · Kapital-Skalierung · Kapital − Reserve − Gebührenpolster · Live-Level ·
25 % der 1-%-Tiefe · halbes Maximum ab halbem Tageslimit Drawdown · kleinste Größe bei negativem
Erwartungswert · **kein Martingale**: nach einem Verlust nie größer als der letzte Trade, ab zwei
Verlusten in Folge halbiert pro Verlust.

**Kapital-Skalierung** 15→5, 20→6, 30→8, 50→12, 100→20 € ist nur ein **Vorschlag** im Dashboard;
das Benutzerlimit wird nie automatisch erhöht. Jede Erhöhung eines Risikolimits ist eine bewusste,
passwortbestätigte Benutzeraktion mit Audit-Eintrag.

## Circuit Breaker

| Breaker | Auslöser | Rücksetzen |
|---|---|---|
| RPC_OUTAGE | kein gesunder RPC-Endpoint | automatisch nach 30 s gesund |
| LATENCY_SPIKE | RPC-Latenz > 3 s | automatisch |
| QUOTE_OUTAGE | Jupiter-Circuit offen | automatisch |
| STALE_QUOTES | Pool-State älter als max(20 s, 10 × Poll) | automatisch |
| DEX_OUTAGE | ein DEX-Adapter nicht verfügbar | automatisch |
| UNEXPECTED_PRICE_MOVE | SOL/EUR > 3 % in 5 min | automatisch |
| UNEXPECTED_SLIPPAGE | Median-Abweichung der letzten 5 > 25 bps | **manuell** |
| TX_FAILURE_SPIKE | ≥ 3 Fehlschläge in den letzten 10 (live) | **manuell** |
| WALLET_MISMATCH | Signer ≠ registriertes Wallet | **manuell** |
| BALANCE_MISMATCH | On-Chain-Saldo ≠ Basis + erfasste Live-Ergebnisse | **manuell** (setzt neue Basis) |
| JITO_PROBLEM | Block-Engine nicht erreichbar | automatisch |
| DATABASE_FAILURE / REDIS_FAILURE | Ping fehlgeschlagen | automatisch |
| SECURITY_FAILURE | Integritätsverletzung | **manuell** |

Wallet-, Saldo-, Fehlschlag- und Jito-Breaker blockieren nur Live; Paper lernt weiter. Breaker-Zustände
überleben Neustarts.

## Live-Levels

Level 1–4 mit max. 1 / 2 / 3 / 5 € pro Trade. **Abstufung automatisch** (Fehlschläge in Folge,
Fehlerquote, Drawdown, negativer Live-Erwartungswert, Live schlechter als Prognose); auf Level 1
stattdessen **Live aus, zurück zu Paper**. **Aufstufung nie automatisch**: nach ≥ 25 Live-Trades mit
signifikant positivem Erwartungswert wird die nächste Stufe *freigabefähig*; der Benutzer bestätigt
mit Passwort, immer nur eine Stufe.

## EMERGENCY STOP

Ein Klick (Top-Bar): keine neuen Trades, Live-Gate sofort `LIVE_LOCKED`, alle Logs und Zustände
bleiben erhalten, das Wallet wird angezeigt. Aufheben nur mit Passwort; Live bleibt danach gesperrt,
bis es erneut freigegeben wird.
