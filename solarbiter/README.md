# SOLARBITER — Solana Multi-DEX Arbitrage

SOLARBITER findet Arbitrage-Gelegenheiten zwischen **Raydium, Orca und Meteora** (direkt und
triangulär), bewertet sie mit **ausführbaren Quotes und einem vollständigen Kostenmodell**, handelt
sie zuerst **auf Papier mit echten Marktdaten**, lernt statistisch aus jedem Ergebnis und schaltet
Echtgeld **erst nach bestandener Validierung und ausdrücklicher manueller Freigabe** frei.

> **NO NET EDGE = NO TRADE.** Kein Trade ohne positive, nutzbare Kante nach *allen* Kosten
> (DEX-Gebühren, Price Impact, Slippage, Netzwerk- und Priority-Fee, Jito-Tip, erwartete
> Fehlschlagkosten, Sicherheitspuffer). Gibt es keine Kante, tut der Bot nichts.

## Was es tut

- **Marktdaten**: Pool-Accounts aller verfolgten Pools werden gebündelt per `getMultipleAccounts`
  gelesen und dekodiert (Raydium AMM v4 / CPMM / CLMM, Orca Whirlpool, Meteora DLMM — Offsets gegen
  Mainnet-Accounts verifiziert).
- **Screening** auf Marginalpreisen (~5 000 Routen pro Minute), danach **Firm-Quotes** von Jupiter,
  je Leg auf genau eine DEX beschränkt, mit Size-Ladder (0,50 – 5,00 €).
- **Atomare Ausführung**: alle Legs in **einer** Transaktion; die Schluss-Leg verkauft über den
  Jupiter-Token-Ledger exakt die gelieferte Menge, ihr Mindest-Output deckt Einsatz + Kosten +
  Mindestgewinn — sonst revertiert die Transaktion. Versand als **Jito-Bundle** (ein revertierendes
  Bundle kostet nichts).
- **Paper / Shadow**: Ausführung nach der gelernten Latenz mit erneuten echten Quotes; Shadow
  simuliert zusätzlich die echte Transaktion mit dem Bot-Wallet.
- **Risk-Engine**, die nicht umgangen werden kann (Einmal-Freigaben, an die Opportunity gebunden),
  14 Circuit Breaker, Tages-/Trade-Verlustgrenzen, Reserve, kein Martingale.
- **Learning**: Ausführungswahrscheinlichkeit, Spread-Decay/Slippage, Latenz, Routen-Zuverlässigkeit,
  Gebühren — chronologisch validiert (60/20/20 + Walk-Forward). Strategie-Versionen mit Rollback.
- **Dashboard** (Next.js, Terminal-Stil) mit Live-Scanner, „Warum kein Trade?“, Erklärung jeder
  Entscheidung, 12 Charts, Steuer-Export (FIFO, EUR — keine Steuerberatung) und EMERGENCY STOP.

## Start per Doppelklick

Einzige Voraussetzung: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (kostenlos)
installieren und einmal starten. Dann im Ordner `solarbiter`:

| | Starten | Stoppen |
|---|---|---|
| **Windows** | `SOLARBITER starten.bat` | `SOLARBITER stoppen.bat` |
| **macOS** | `SOLARBITER starten.command` | `SOLARBITER stoppen.command` |
| **Linux** | einmal `bash scripts/launcher/launcher.sh desktop` → Anwendungsmenü | ebenso |

Beim **ersten Start** fragt das Fenster nach der RPC-URL (z. B. Helius) und optional nach einem
Jupiter-Key, legt die `.env` mit einem zufälligen Datenbank-Passwort an, baut das Programm (einige
Minuten, nur beim ersten Mal) und fragt nach Benutzername und Passwort fürs Dashboard. Danach öffnet
sich das Dashboard im Browser (`http://127.0.0.1:8788`). Der Bot läuft im Hintergrund weiter, bis du
„SOLARBITER stoppen“ doppelklickst; die Daten bleiben erhalten.

- **macOS**: Bei „kann nicht geöffnet werden, da es von einem nicht verifizierten Entwickler stammt“
  einmal *Systemeinstellungen → Datenschutz & Sicherheit → Trotzdem öffnen* wählen. Fehlt das
  Ausführungsrecht (ZIP-Download): `chmod +x *.command` im Terminal im Ordner `solarbiter`.
- **Windows**: Bei der SmartScreen-Warnung *Weitere Informationen → Trotzdem ausführen*.

## Schnellstart (lokal, für Entwickler)

Voraussetzungen: Node ≥ 22, pnpm 10, PostgreSQL 16, Redis 7.

```bash
cd solarbiter
pnpm install
cp .env.example .env            # RPC / Jupiter-Key eintragen (optional)
pnpm db:migrate && pnpm db:seed
pnpm user:create admin          # Passwort per stdin (min. 12 Zeichen)
pnpm dev:worker                 # Marktdaten, Scanner, Paper-Trading
pnpm dev:api                    # API auf 127.0.0.1:8788
pnpm --filter @solarbiter/web build   # Dashboard-Export, wird von der API ausgeliefert
# Dashboard: WEB_DIST_DIR=apps/web/out pnpm dev:api  →  http://127.0.0.1:8788
```

Oder komplett per Docker: `docker compose up -d --build` (siehe [DEPLOYMENT](docs/DEPLOYMENT.md)).

Der Bot startet immer in **PAPER**. Echtgeld erfordert *alle* folgenden Punkte:
`LIVE_MODE=true` in der Umgebung · bestandenes Validierungs-Gate (`LIVE_READY`) · Bot-Wallet ·
keine offenen Breaker · die Eingabe **„ENABLE LIVE TRADING“** plus Passwort. Gestartet wird auf
Level 1 (max. 1 € pro Trade).

## Startkapital und Grenzen (Standard)

| | |
|---|---|
| Startkapital | 15 € · Reserve ≥ 10 € · max. 5 € pro Trade · 1 Trade gleichzeitig |
| Verlustgrenzen | max. 0,30 € pro Trade · 0,75 € pro Tag · 3 Fehlschläge in Folge |
| Live-Level | 1 / 2 / 3 / 4 → max. 1 / 2 / 3 / 5 € pro Trade (Erhöhung nur manuell) |
| Kapital-Skalierung | 15→5, 20→6, 30→8, 50→12, 100→20 € — nur als *Vorschlag* |

**Risikolimits werden nie automatisch erhöht.** Das System darf Risiko nur senken (Level-Abstufung,
Breaker, Pause, Rückkehr zu Paper).

## Dokumentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Komponenten, Datenfluss, Pakete |
| [SETUP](docs/SETUP.md) | Installation, Konfiguration, erster Start |
| [TRADING_ENGINE](docs/TRADING_ENGINE.md) | Entscheidungs-Pipeline, Kostenmodell |
| [ARBITRAGE](docs/ARBITRAGE.md) | Screening, Firm-Quotes, Size-Ladder, atomare Transaktion |
| [PAPER_TRADING](docs/PAPER_TRADING.md) | Paper- und Shadow-Modus |
| [LEARNING](docs/LEARNING.md) | Modelle, Validierung, Live-Gate, Optimizer |
| [RISK](docs/RISK.md) | Risk-Engine, Breaker, Sizing, Notstopp |
| [LIVE_TRADING](docs/LIVE_TRADING.md) | Freigabe, Levels, Ausführung |
| [JITO](docs/JITO.md) | Bundles und Tips |
| [WALLET](docs/WALLET.md) | Keystore, Signer, Transaction-Guard |
| [TAX](docs/TAX.md) | Steuer-Dokumentation und Export |
| [API](docs/API.md) | REST und WebSocket |
| [DATABASE](docs/DATABASE.md) | Schema und Unveränderlichkeit |
| [SECURITY](docs/SECURITY.md) | Sicherheitsmodell |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker, Compose, Betrieb |
| [TESTING](docs/TESTING.md) | Unit-, Integrations-, Simulations- und Chaos-Tests |

## Haftung

Arbitrage auf Solana ist hart umkämpft. SOLARBITER verspricht **keine Gewinne**; Paper-Ergebnisse
sind keine Garantie für Live-Ergebnisse (insbesondere die Konkurrenz um Blockplatz ist im Paper-Modus
nicht beobachtbar). Setze nur Geld ein, dessen Verlust du verkraften kannst.
