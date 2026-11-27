#!/usr/bin/env bash
# INFRA-006: Automated backup for SAG PostgreSQL 16 and Qdrant vector collections to Cloudflare R2.
# Produces custom-format pg_dump + Qdrant per-collection snapshots + SHA-256 digests + retention pruning.

set -euo pipefail

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-/tmp/continuum-backups/sag}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
QDRANT_URL="${QDRANT_URL:-http://127.0.0.1:6333}"
QDRANT_COLLECTIONS="${QDRANT_COLLECTIONS:-sag_chunks}"

mkdir -p "$BACKUP_DIR"

# 1. PostgreSQL backup (requires PGHOST/PGUSER/PGDATABASE or DATABASE_URL)
PG_ARCHIVE="${BACKUP_DIR}/sag-postgres-${TIMESTAMP}.dump"
PG_SHA="${PG_ARCHIVE}.sha256"

if [[ -n "${SAG_POSTGRES_URL:-}" ]]; then
  echo "[backup-sag] Dumping SAG PostgreSQL via SAG_POSTGRES_URL..."
  pg_dump --format=custom --no-owner --no-privileges --file="$PG_ARCHIVE" "$SAG_POSTGRES_URL"
else
  echo "[backup-sag] Dumping SAG PostgreSQL via PG* environment variables..."
  pg_dump --format=custom --no-owner --no-privileges --file="$PG_ARCHIVE"
fi

sha256sum "$PG_ARCHIVE" > "$PG_SHA"
pg_restore --list "$PG_ARCHIVE" >/dev/null
echo "[backup-sag] PostgreSQL dump verified (pg_restore --list OK): $PG_ARCHIVE"

# 2. Qdrant collection snapshots
QDRANT_AUTH_HEADER=()
if [[ -n "${QDRANT_API_KEY:-}" ]]; then
  QDRANT_AUTH_HEADER=(-H "api-key: ${QDRANT_API_KEY}")
fi

SNAPSHOT_FILES=()
IFS=',' read -ra COLLECTIONS <<< "$QDRANT_COLLECTIONS"
for COLLECTION in "${COLLECTIONS[@]}"; do
  COLLECTION="$(echo "$COLLECTION" | xargs)"
  [[ -z "$COLLECTION" ]] && continue
  echo "[backup-sag] Creating Qdrant snapshot for collection '${COLLECTION}'..."
  SNAP_JSON="$(curl -fsSL -X POST "${QDRANT_AUTH_HEADER[@]}" \
    "${QDRANT_URL%/}/collections/${COLLECTION}/snapshots")"
  SNAP_NAME="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["result"]["name"])' "$SNAP_JSON")"
  SNAP_LOCAL="${BACKUP_DIR}/qdrant-${COLLECTION}-${TIMESTAMP}-${SNAP_NAME}"
  curl -fsSL "${QDRANT_AUTH_HEADER[@]}" \
    "${QDRANT_URL%/}/collections/${COLLECTION}/snapshots/${SNAP_NAME}" \
    -o "$SNAP_LOCAL"
  sha256sum "$SNAP_LOCAL" > "${SNAP_LOCAL}.sha256"
  SNAPSHOT_FILES+=("$SNAP_LOCAL" "${SNAP_LOCAL}.sha256")
  echo "[backup-sag] Downloaded Qdrant snapshot: $SNAP_LOCAL"
done

# 3. Upload to Cloudflare R2 + prune expired objects
if [[ -n "${R2_ENDPOINT:-}" && -n "${R2_BACKUP_BUCKET:-}" ]]; then
  PREFIX="${R2_SAG_BACKUP_PREFIX:-backups/sag}"
  for FILE in "$PG_ARCHIVE" "$PG_SHA" "${SNAPSHOT_FILES[@]}"; do
    aws s3 cp "$FILE" "s3://${R2_BACKUP_BUCKET}/${PREFIX}/$(basename "$FILE")" \
      --endpoint-url "$R2_ENDPOINT"
  done

  CUTOFF_ISO="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
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
  echo "[backup-sag] R2_ENDPOINT/R2_BACKUP_BUCKET not set; keeping local archives only."
fi

find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
echo "[backup-sag] Completed successfully at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
