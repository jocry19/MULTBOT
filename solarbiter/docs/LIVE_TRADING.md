# Live-Trading

**Echtgeld ist eine manuelle Benutzeraktion. Das System aktiviert niemals selbst Echtgeld.**

## Voraussetzungen (alle gleichzeitig)

1. `LIVE_MODE=true` in der Umgebung des Workers **und** der API (harter Schalter).
2. Validierungs-Gate bestanden → Zustand `LIVE_READY` (siehe [LEARNING](LEARNING.md)).
3. Konfiguriertes, gedecktes Bot-Wallet (siehe [WALLET](WALLET.md)).
4. Keine offenen Circuit Breaker, kein Notstopp, Worker online.
5. Auf *Live Trading* die Phrase **ENABLE LIVE TRADING** exakt eintippen **und** das Passwort eingeben.

Danach: `LIVE_ENABLED`, Bot-Zustand `LIVE`, Start auf **Level 1 (max. 1 € pro Trade)**.

## Ausführung (`LiveExecutor`)

```
Risk-Freigabe (einmalig, gebunden)
→ Idempotenz (execution_attempts, ein Versuch je Opportunity)
→ FINALER PROFIT-CHECK: alle Legs mit Priorität "final" frisch quoten; Abbruch, wenn die Kante
  ≤ 0 ist oder unter 80 % der freigegebenen Kante fällt
→ Bau der Legs mit Profit-Guard der Schluss-Leg, Prüfung des kodierten Mindest-Outputs
→ Simulation der kompletten Transaktion mit dem Wallet (Verlust ≤ Gebühren + Tip + Rent)
→ Compute-Unit-Optimierung (verbraucht × 1,1 + 10 000), Priority-Preis = Fee / CU
→ statischer Transaction-Guard → Integrity-Approval → Signer
→ Jito-Bundle (oder RPC mit Preflight)
→ Warten auf Landung, Bestätigung per Signatur-Status
→ realisiertes Ergebnis aus pre/post-Balance des Wallets (Rent neu angelegter Token-Konten wird als
  gebunden, nicht als Verlust geführt)
```

Kein automatischer Retry, nie eine zweite Transaktion für dieselbe Opportunity, kein Ergebnis, das
nicht von der Chain gelesen wurde. Unbekannte Ergebnisse (nicht auffindbar) werden als `UNKNOWN`
geführt und nicht als Gewinn gezählt.

## Nach jedem Live-Trade

- Learning-Sample (inkl. realisierte Slippage, Latenz, bezahlte Gebühren).
- Steuer-Dokumentation (FIFO, EUR) — siehe [TAX](TAX.md).
- Level-Statistik: automatische Abstufung bzw. Rückkehr zu Paper bei Verschlechterung;
  Freigabefähigkeit des nächsten Levels wird berechnet (Bestätigung durch den Benutzer).
- Wallet-Abgleich (On-Chain-Saldo vs. Basis + erfasste Ergebnisse).

## Deaktivieren

*Live Trading → Live deaktivieren* oder EMERGENCY STOP. Beides wirkt sofort für neue Trades.
