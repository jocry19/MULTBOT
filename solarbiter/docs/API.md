# API

Basis: `http://127.0.0.1:8788` (same-origin mit dem Dashboard). Alle `/api/*`-Routen außer
`/api/auth/login`, `/api/auth/status` und `/api/health` verlangen eine Session; jede nicht-GET-Anfrage
den Header `X-Requested-With: solarbiter`. Antworten: JSON, große Zahlen (Lamports) als Strings.

## Lesen

| Route | Inhalt |
|---|---|
| `GET /api/status` | Bot-Zustand, Live-Gate, Schalter, Komponenten, Breaker, Startsequenz, Heartbeat |
| `GET /api/markets` | dekodierte Pools (Preis, Fee, TVL, Alter) und Token-Universum mit Sicherheitsprüfung |
| `GET /api/scanner` | Screening-Kandidaten, verifizierte Opportunities, Queue/Backoff |
| `GET /api/opportunities?status=&reason=&mode=&limit=&before=` | Opportunity-Liste |
| `GET /api/opportunities/:id` | Detail inkl. Erklärung, Wasserfall, Ladder, Legs, Quotes, Trades |
| `GET /api/why-no-trade?hours=` | Ablehnungsgründe (Firm-Quote-Stufe und Screening) |
| `GET /api/paper/performance`, `GET /api/live/performance` | Portfolio, Kennzahlen, Tages-P&L |
| `GET /api/paper/trades`, `GET /api/live/trades` | Trades |
| `GET /api/transactions` | Transaktionen, Ausführungsversuche, Jito-Bundles |
| `GET /api/positions`, `GET /api/orders` | laufende Ausführungen, Token-Bestände, Versuche |
| `GET /api/learning` | Learning-Snapshot, Gate, Validierung, Historie, Strategie-Versionen |
| `GET /api/risk` | Größen-Obergrenze, Skalierungsvorschlag, Limits, Levels, Breaker, Risiko-Ereignisse |
| `GET /api/wallet` | Adresse, Salden, Abgleiche (nie Schlüsselmaterial) |
| `GET /api/charts?hours=` | Datensätze der Dashboard-Charts |
| `GET /api/tax/export?format=csv\|json&from=&to=`, `GET /api/tax/summary` | Steuer-Export |
| `GET /api/logs`, `GET /api/notifications`, `GET /api/settings`, `GET /api/watchlist` | |

## Steuern

| Route | Wirkung / Bedingungen |
|---|---|
| `POST /api/bot/start` · `POST /api/bot/stop` | RUNNING (Paper/Shadow) bzw. PAUSED |
| `POST /api/bot/shadow {enabled}` | Shadow-Modus |
| `POST /api/live/enable {confirmation, password}` | nur bei `LIVE_MODE`, Gate `LIVE_READY`, Wallet, keine Breaker, Phrase „ENABLE LIVE TRADING“, korrektes Passwort |
| `POST /api/live/disable` | sofort `LIVE_LOCKED` |
| `POST /api/live/level {level, password?}` | senken immer; erhöhen nur +1, nur wenn freigabefähig, mit Passwort |
| `POST /api/emergency-stop {reason}` | Notstopp, Live gesperrt |
| `POST /api/emergency-release {password}` | Notstopp aufheben |
| `POST /api/breakers/:id/reset` | Breaker zurücksetzen |
| `PUT /api/settings {patch, password?}` | validiert, auditiert; jede Risikoerhöhung braucht das Passwort |
| `POST /api/learning/optimize` · `POST /api/wallet/refresh` | sofort ausführen |
| `POST/DELETE /api/watchlist` · `POST /api/notifications/read` | |
| `POST /api/auth/login {username, password}` · `POST /api/auth/logout` | Session-Cookie `sb_session` (httpOnly, SameSite=Strict) |

Steuerbefehle schreiben zuerst den Zustand in die Datenbank und signalisieren danach den Worker.

## WebSocket `GET /api/ws`

Nur mit gültiger Session. Ereignisse `{type, ts, payload}`: `QUOTE_UPDATED`, `OPPORTUNITY_DETECTED`,
`OPPORTUNITY_REJECTED`, `PAPER_TRADE_CREATED`, `PAPER_TRADE_CLOSED`, `LIVE_TRADE_CREATED`,
`LIVE_TRADE_CLOSED`, `TRANSACTION_SUBMITTED`, `TRANSACTION_CONFIRMED`, `TRANSACTION_FAILED`,
`WALLET_UPDATED`, `P&L_UPDATED`, `RISK_TRIGGERED`, `LEARNING_UPDATED`, `SYSTEM_ERROR`,
`STATUS_UPDATED`, `NOTIFICATION`, `LOG`.

## Fehler

`400` Validierung (mit Feldern) · `401` keine Session · `403` CSRF-Header fehlt bzw. Passwort nötig ·
`409` Vorbedingung nicht erfüllt (mit Gründen) · `429` Ratenlimit (Login 10/5 min, Schreiben 60/min,
Lesen 600/min je IP).
