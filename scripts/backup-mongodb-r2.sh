#!/usr/bin/env bash
# INFRA-006: Full Continuum AI MongoDB multi-database backup to Cloudflare R2
# Dumps all 10 service-owned databases with --oplog point-in-time consistency,
# computes SHA-256 verification digest, optionally runs mongorestore --dryRun,
# uploads to R2, and prunes remote archives older than RETENTION_DAYS.

set -euo pipefail

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-/tmp/continuum-backups/mongodb}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
VERIFY_DRY_RUN="${VERIFY_DRY_RUN:-false}"
if [[ "${1:-}" == "--verify" ]]; then
  VERIFY_DRY_RUN="true"
fi

# Strip any trailing database path suffix (e.g. /continuum) so mongodump backs up ALL 10 service DBs.
RAW_MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017/?replicaSet=rs0}"
MONGODB_CLUSTER_URI="$(python3 - "$RAW_MONGODB_URI" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
parts = urlsplit(sys.argv[1])
print(urlunsplit((parts.scheme, parts.netloc, '/', parts.query, parts.fragment)))
PY
)"

# Documented inventory of all 10 service-owned databases in Continuum AI:
SERVICE_DATABASES=(
  "continuum_iam"
  "continuum_capture"
  "continuum_task"
  "continuum_handover"
  "continuum_chat"
  "continuum_notification"
  "continuum_lifecycle"
  "continuum_jira"
  "continuum_ingestion"
  "continuum_audit"
)

mkdir -p "$BACKUP_DIR"
ARCHIVE_FILE="${BACKUP_DIR}/continuum-mongodb-all-${TIMESTAMP}.archive.gz"
CHECKSUM_FILE="${ARCHIVE_FILE}.sha256"

echo "[backup-mongodb] Starting --oplog full cluster dump (${#SERVICE_DATABASES[@]} service DBs)..."
mongodump \
  --uri="$MONGODB_CLUSTER_URI" \
  --oplog \
  --gzip \
  --archive="$ARCHIVE_FILE"

sha256sum "$ARCHIVE_FILE" > "$CHECKSUM_FILE"
echo "[backup-mongodb] Archive created: $ARCHIVE_FILE ($(du -h "$ARCHIVE_FILE" | cut -f1))"
cat "$CHECKSUM_FILE"

if [[ "$VERIFY_DRY_RUN" == "true" ]]; then
  echo "[backup-mongodb] Running mongorestore --dryRun verification..."
  sha256sum -c "$CHECKSUM_FILE"
  mongorestore \
    --uri="$MONGODB_CLUSTER_URI" \
    --gzip \
    --archive="$ARCHIVE_FILE" \
    --oplogReplay \
    --dryRun
  echo "[backup-mongodb] Dry-run verification succeeded."
fi

if [[ -n "${R2_ENDPOINT:-}" && -n "${R2_BACKUP_BUCKET:-}" ]]; then
  PREFIX="${R2_BACKUP_PREFIX:-backups/mongodb}"
  echo "[backup-mongodb] Uploading archive & checksum to s3://${R2_BACKUP_BUCKET}/${PREFIX}/..."
  aws s3 cp "$ARCHIVE_FILE" "s3://${R2_BACKUP_BUCKET}/${PREFIX}/$(basename "$ARCHIVE_FILE")" \
    --endpoint-url "$R2_ENDPOINT"
  aws s3 cp "$CHECKSUM_FILE" "s3://${R2_BACKUP_BUCKET}/${PREFIX}/$(basename "$CHECKSUM_FILE")" \
    --endpoint-url "$R2_ENDPOINT"

  # Prune remote objects older than RETENTION_DAYS
  CUTOFF_ISO="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
  echo "[backup-mongodb] Pruning backups older than ${CUTOFF_ISO} (${RETENTION_DAYS} days)..."
  aws s3api list-objects-v2 \
    --bucket "$R2_BACKUP_BUCKET" \
    --prefix "${PREFIX}/" \
    --endpoint-url "$R2_ENDPOINT" \
    --query "Contents[?LastModified<='${CUTOFF_ISO}'].Key" \
    --output text | tr '\t' '\n' | while read -r key; do
      if [[ -n "$key" && "$key" != "None" ]]; then
        aws s3 rm "s3://${R2_BACKUP_BUCKET}/${key}" --endpoint-url "$R2_ENDPOINT"
      fi
    done
else
  echo "[backup-mongodb] R2_ENDPOINT/R2_BACKUP_BUCKET not set; keeping local archive only."
fi

# Local staging cleanup
find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
echo "[backup-mongodb] Completed successfully at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
