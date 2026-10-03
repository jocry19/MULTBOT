# Deployment

## Docker Compose (empfohlen)

```bash
cd solarbiter
cp .env.example .env                 # POSTGRES_PASSWORD, RPC, Jupiter-Key … setzen
mkdir -p secrets && chmod 700 secrets   # optional: Keystore + wallet_passphrase (chmod 600)
docker compose up -d --build
read -rs PW && printf '%s\n' "$PW" | docker compose run --rm -T api node apps/api/dist/cli/user.js admin; unset PW
```

Dashboard: `http://127.0.0.1:8788`. Für Zugriff von außen einen TLS-Reverse-Proxy (Caddy, nginx)
vorschalten — die API bindet bewusst nur an localhost.

| Dienst | Aufgabe | Health-Check |
|---|---|---|
| `postgres` | Datenbank (getunte `postgresql.conf`, Backup-Skript) | `pg_isready` |
| `redis` | Pub/Sub + Status-Snapshots (keine Persistenz nötig) | `redis-cli ping` |
| `migrate` | einmalig: Migrationen + Seed | — (muss erfolgreich enden) |
| `worker` | Trading-Engine; **einziger** Dienst mit `secrets/` | `GET 127.0.0.1:9464/health` |
| `api` | REST, WebSocket, Dashboard | `GET /api/health` |

Das Image (`infrastructure/docker/Dockerfile`) baut alle Pakete typisiert, die API, den Worker und den
Dashboard-Export und läuft als Nicht-Root-Benutzer. Hinter einem TLS-abfangenden Proxy:
`docker build --secret id=extra_ca,src=ca.crt --build-arg HTTPS_PROXY=… -f infrastructure/docker/Dockerfile .`

## Ohne Docker

```bash
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed
NODE_ENV=production node apps/worker/dist/main.js
NODE_ENV=production WEB_DIST_DIR=apps/web/out node apps/api/dist/main.js
```

Als Dienste z. B. per systemd (`Restart=always`); beide Prozesse beenden sich sauber auf SIGTERM.

## Betrieb

- **Metriken**: Prometheus-Format unter `127.0.0.1:9464/metrics` (Worker): RPC- und Quote-Latenz,
  Opportunities nach Ergebnis, Transaktionen, Jito-Bundles, Wallet-Saldo, offene Breaker, Prozess.
- **Logs**: JSON (pino) auf stdout und optional rotierend in `LOG_DIR`; Geheimnisse werden entfernt.
- **Backups**: `docker compose exec -T postgres sh /backup/backup.sh` (z. B. täglich per Cron).
- **Updates**: `docker compose up -d --build` — Migrationen laufen automatisch und idempotent.
- **RPC**: für ernsthaften Betrieb einen dedizierten RPC mit Fallback (`SOLANA_RPC_FALLBACK_URLS`) und
  einen Jupiter-Key (höheres Quote-Budget) verwenden.
