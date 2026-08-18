#!/usr/bin/env bash
#
# Nightly backup: the database, and the uploads that the database only holds
# keys for. Restoring one without the other leaves rows pointing at agreements
# that are not there, so both go in the same dated pair.
#
# Install (as the deploy user, from the repo directory):
#   chmod +x deploy/backup.sh
#   crontab -e
#   15 2 * * * /srv/ff-erp/deploy/backup.sh >> /var/log/ff-erp-backup.log 2>&1
#
# A backup you have never restored is a hope, not a backup. Section 9 of
# docs/DEPLOY_VPS.md is the restore drill — do it once before you need it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ff-erp}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE="docker compose -f ${REPO_DIR}/docker-compose.prod.yml --env-file ${REPO_DIR}/.env.production"

# shellcheck disable=SC1091
set -a; source "${REPO_DIR}/.env.production"; set +a

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${BACKUP_DIR}"

echo "[$(date -uIs)] backup ${stamp} starting"

# --- database -------------------------------------------------------------
# --format=custom so pg_restore can be selective, and so the dump survives a
# Postgres version bump better than plain SQL.
db_file="${BACKUP_DIR}/db-${stamp}.dump"
${COMPOSE} exec -T postgres \
  pg_dump --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB:-ff_erp}" \
          --format=custom --compress=6 \
  > "${db_file}.partial"
mv "${db_file}.partial" "${db_file}"
echo "  database  $(du -h "${db_file}" | cut -f1)  ${db_file}"

# --- uploads --------------------------------------------------------------
files_file="${BACKUP_DIR}/files-${stamp}.tar.gz"
${COMPOSE} exec -T api tar -cf - -C /app/storage . \
  | gzip -6 > "${files_file}.partial"
mv "${files_file}.partial" "${files_file}"
echo "  uploads   $(du -h "${files_file}" | cut -f1)  ${files_file}"

# --- prune ----------------------------------------------------------------
find "${BACKUP_DIR}" -name 'db-*.dump'     -mtime "+${KEEP_DAYS}" -delete
find "${BACKUP_DIR}" -name 'files-*.tar.gz' -mtime "+${KEEP_DAYS}" -delete

# --- offsite --------------------------------------------------------------
# A copy on the same disk survives a bad migration. It does not survive the
# VPS being deleted, the provider losing the volume, or ransomware. Set
# OFFSITE_REMOTE to an rclone remote (Cloudflare R2 and Backblaze B2 both have
# free tiers large enough for this) and this becomes a real backup.
if [[ -n "${OFFSITE_REMOTE:-}" ]] && command -v rclone >/dev/null 2>&1; then
  rclone copy "${db_file}"    "${OFFSITE_REMOTE}" --no-traverse
  rclone copy "${files_file}" "${OFFSITE_REMOTE}" --no-traverse
  echo "  offsite   pushed to ${OFFSITE_REMOTE}"
else
  echo "  offsite   SKIPPED — OFFSITE_REMOTE unset or rclone missing"
fi

echo "[$(date -uIs)] backup ${stamp} done"
