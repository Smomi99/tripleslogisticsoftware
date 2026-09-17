#!/usr/bin/env bash
#
# Read-only production audit: which load plans carry figures from the
# short-shipment bug fixed on 2026-09-14?
#
# Runs docs/sql/clp-short-shipment-audit.sql against the production database
# over SSH and prints the result. It changes nothing, and is built so that it
# cannot:
#
#   - the session is opened with default_transaction_read_only = on, so the
#     server itself refuses any write, whatever the SQL file happens to say
#   - ON_ERROR_STOP means a refusal is loud rather than skipped
#
# That belt-and-braces is deliberate. A script that reads production today is
# a script somebody edits to fix production next month, and the guard should
# already be there when they do.
#
# Usage, from the repository root:
#
#   scripts/prod-clp-audit.sh                      # table, to the terminal
#   scripts/prod-clp-audit.sh --csv > audit.csv    # CSV, to a file
#   PROD_HOST=deploy@1.2.3.4 scripts/prod-clp-audit.sh
#
set -euo pipefail

HOST="${PROD_HOST:-deploy@72.61.123.148}"
APP_DIR="${PROD_DIR:-/srv/ff-erp}"
SQL="$(dirname "$0")/../docs/sql/clp-short-shipment-audit.sql"

if [ ! -f "$SQL" ]; then
  echo "Cannot find $SQL — run this from the repository root." >&2
  exit 1
fi

FORMAT_ARGS=()
if [ "${1:-}" = "--csv" ]; then
  FORMAT_ARGS=(--csv)
fi

# The SQL is sent over stdin rather than copied to the server: nothing is left
# behind on the box, and what runs is exactly what is in the repository.
{
  echo "SET default_transaction_read_only = on;"
  cat "$SQL"
} | ssh "$HOST" "bash -lc '
    set -euo pipefail
    cd \"$APP_DIR\"
    set -a; source .env.production; set +a
    docker compose -f docker-compose.prod.yml --env-file .env.production \
      exec -T postgres psql \
        -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" \
        -v ON_ERROR_STOP=1 ${FORMAT_ARGS[*]:-} -f -
  '"
