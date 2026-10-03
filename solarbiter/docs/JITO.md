# Jito

## Warum Bundles

Eine Arbitrage-Transaktion, deren Profit-Guard revertiert, wird als Jito-Bundle **gar nicht
aufgenommen** — sie kostet weder Basis- noch Priority-Fee noch Tip. Per normaler RPC-Transaktion
würden bei einem Revert die Gebühren fällig. Daher ist die erwartete Fehlschlagkosten-Komponente bei
Jito 0.

## Verwendete Schnittstellen (gegen die offizielle Doku geprüft)

| Zweck | Endpoint |
|---|---|
| Bundle senden | `POST {blockEngine}/api/v1/bundles` · `sendBundle` · `[[base64…], {"encoding":"base64"}]` · max. 5 Transaktionen |
| Tip-Konten | `POST {blockEngine}/api/v1/bundles` · `getTipAccounts` (8 Konten) |
| Status | `POST {blockEngine}/api/v1/getInflightBundleStatuses` (`Pending`/`Landed`/`Failed`/`Invalid`), `getBundleStatuses` |
| Tip-Niveau | `GET bundles.jito.wtf/api/v1/bundles/tip_floor` (Perzentile gelandeter Tips, in SOL) |

Standard-Ratenlimit: 1 Request / s / IP / Region — der Client hält diesen Abstand ein. Optionaler
`x-jito-auth`-Header über `JITO_AUTH`.

## Tip

```
Tip = interpoliertes Perzentil (jitoTipPercentile, Standard p50) der gelandeten Tips
      ≥ 1 000 Lamports (Jito-Minimum)
      ≤ maxJitoTipLamports
      ≤ maxJitoTipShareOfProfit × erwarteter Gewinn
```

**Der Tip ist immer echte Kosten** und steht im Kostenmodell. Bleibt nach dem Tip keine Kante
(oder frisst der Tip mehr als den erlaubten Anteil) → `JITO_TOO_EXPENSIVE`, kein Trade.

Der Tip ist ein `SystemProgram.transfer` an ein zufälliges Tip-Konto als letzte Instruktion der
Transaktion; der Transaction-Guard erlaubt SOL-Transfers ausschließlich an diese Konten (und an das
eigene wSOL-Konto) mit Betragsgrenzen.

Ist die Block-Engine nicht erreichbar, öffnet `JITO_PROBLEM` (blockiert nur Live). Jito kann in den
Einstellungen deaktiviert werden (`strategy.useJito`); dann wird per RPC gesendet und die
Fehlschlagkosten steigen entsprechend (wirksam nach Neustart des Workers).
