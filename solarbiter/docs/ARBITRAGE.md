# Arbitrage

## Marktdaten

| DEX | Pool-Typen | Discovery | On-Chain-Prüfung |
|---|---|---|---|
| Raydium | AMM v4, CPMM, CLMM | `api-v3.raydium.io/pools/info/mint` | Owner-Programm, Mints, Vaults, Fee aus Account/Config |
| Orca | Whirlpool | `api.orca.so/v2/solana/pools?tokensBothOf=` | Owner, Mints, Vaults; Fee immer aus dem Account |
| Meteora | DLMM | `dlmm.datapi.meteora.ag/pools?query=` | Owner, Mints, Reserves, Bin-Step; Basisgebühr aus dem Account |

Alle Decoder-Offsets wurden gegen echte Mainnet-Accounts verifiziert (`packages/dex/src/__fixtures__`):
die SOL/USDC-Preise von v4, Whirlpool, CLMM und DLMM stimmen auf < 0,5 % überein. Das Token-Universum
(SOL, USDC, USDT, JUP, BONK, WIF, JTO, PYTH, RAY, ORCA, mSOL, JitoSOL) wird beim Start on-chain
geprüft (Programm, Decimals, Mint-/Freeze-Authority, Allow-/Denylist).

## Zwei Stufen

1. **Screening** auf Marginalpreisen: billig, ~5 000 Routen/min, nur zur Kandidatenauswahl.
2. **Firm-Quotes** (Jupiter `/quote`), je Leg mit `dexes=<Venue-Labels der DEX>`,
   `onlyDirectRoutes=true`, `maxAccounts` (damit alle Legs in eine Transaktion passen),
   `forJitoBundle=true`, `instructionVersion=V1`. Jede Entscheidung fällt nur auf Firm-Quotes.

Venue-Labels: Raydium = `Raydium`, `Raydium CP`, `Raydium CLMM`; Orca = `Whirlpool`;
Meteora = `Meteora DLMM`, `Meteora`, `Meteora DAMM v2`.

**Quote-Budget**: Jupiter begrenzt im gleitenden 60-s-Fenster (keyless 30, Free 60, Developer 600 …).
Das Budget hält 10 % Sicherheitsabstand und vergibt nach Priorität: `final`/`requote` dürfen das
ganze Fenster nutzen, `verify` 75 %, `ladder` 50 %. Die Prüfungen, die Geld schützen, werden nie von
explorativen Quotes verdrängt.

**Frische**: `quote_age > MAX_QUOTE_AGE_MS` → `QUOTE_TOO_OLD`, ohne Ausnahme. Die Risk-Freigabe
läuft genau dann ab, wenn die Quote zu alt würde.

## Strategien

- **Direkt**: SOL → Token auf DEX A, Token → SOL auf DEX B (A ≠ B).
- **Triangulär**: SOL → A → B → SOL über beliebige Venues, maximal 3 Swaps (`maxTriangularSwaps`, 4
  vorbereitet).

## Size-Ladder

Größen 0,50 … 5,00 € (gedeckelt durch die Risk-Engine). Probe-Quote bei mittlerer Größe → lineares
Impact-Modell `r(x) = r0 − c·x` → jede Größe mit vollem Kostenmodell → Maximum des erwarteten
Nettogewinns. Die gewählte Größe wird **immer** erneut firm gequotet.

## Atomare Transaktion

```
ComputeBudget(limit, price)
Leg 1 setup, [set_token_ledger der Schluss-Leg], Leg 1 swap         ← direkt
… Zwischen-Legs (feste Inputs = Minimum der Vor-Leg) …               ← triangulär
Schluss-Leg setup, swap (Token-Ledger: verkauft exakt die gelieferte Menge), cleanup (wSOL schließen)
Jito-Tip-Transfer
```

- Der **Token-Ledger** (Jupiter `route_with_token_ledger`, live verifiziert) misst den Zuwachs des
  Token-Kontos seit `set_token_ledger` — es bleiben keine Token-Reste.
- Der **Mindest-Output der Schluss-Leg** wird so gesetzt, dass er Einsatz + Basisgebühr +
  Priority-Fee + Tip + Mindestgewinn deckt (`closingGuard`). Bewegt sich der Markt bis zur Landung
  dagegen, revertiert die gesamte Transaktion.
- Jede von Jupiter gelieferte Swap-Instruktion wird dekodiert und muss exakt Quote-Input,
  Quote-Output und die angeforderte Slippage enthalten — sonst `IntegrityError`, nichts wird signiert.
- Passt die Transaktion (mit Lookup-Tables) nicht in 1 232 Bytes → `NOT_ATOMIC`, kein Trade.
