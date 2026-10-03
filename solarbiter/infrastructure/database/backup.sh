#!/usr/bin/env sh
# Daily logical backup of the SOLARBITER database (trades, tax ledger, audit trail).
#   docker compose exec -T postgres sh /backup/backup.sh
set -eu
ts=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump -U "${POSTGRES_USER:-solarbiter}" -d "${POSTGRES_DB:-solarbiter}" -Fc -f "/backup/solarbiter-$ts.dump"
find /backup -name 'solarbiter-*.dump' -mtime +14 -delete
echo "backup written: solarbiter-$ts.dump"
