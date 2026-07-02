#!/bin/sh
set -e

DB="${TOKENLEADER_DB:-${TOKENLEADER_DATA_DIR:-/data}/tokenleader.sqlite}"

# If a staged import exists, move it over the DB before the server opens it.
restore_import() {
  if [ -f "${DB}.import" ]; then
    echo "[tokenleader] restoring ${DB}.import -> ${DB}"
    rm -f "${DB}-wal" "${DB}-shm"
    mv "${DB}.import" "${DB}"
  fi
}

# Optional continuous backup. When LITESTREAM_REPLICA_URL is set the server
# runs under `litestream replicate -exec` (replication lives and dies with
# the server process), and a MISSING db is first restored from the replica —
# the full disaster-recovery loop for a lost volume. Unset = plain server.
#
# Credentials ride Litestream's standard env vars (LITESTREAM_ACCESS_KEY_ID /
# LITESTREAM_SECRET_ACCESS_KEY); S3-compatible stores (R2, B2, minio) work
# via `?endpoint=…` in the URL, e.g.
#   s3://bucket/tokenleader?endpoint=https://<account>.r2.cloudflarestorage.com
#
# A restore failure with the db missing aborts boot deliberately (set -e):
# starting FRESH next to a populated replica would begin a new generation and
# bury the good backup — a supervisor retry is the safe response.
run_server() {
  if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
    if [ ! -f "${DB}" ]; then
      echo "[tokenleader] db missing — restoring from replica"
      litestream restore -if-replica-exists -o "${DB}" "${LITESTREAM_REPLICA_URL}"
    fi
    echo "[tokenleader] starting under litestream replication"
    exec litestream replicate -exec "$*" "${DB}" "${LITESTREAM_REPLICA_URL}"
  fi
  exec "$@"
}

if [ "$(id -u)" = "0" ]; then
  # Started as root (docker default, Railway, Fly): fix volume ownership, then drop privileges.
  # Same pattern as official postgres/redis images; removes the RAILWAY_RUN_UID=0 footgun.
  # Re-exec THIS script under setpriv so the litestream branch also runs unprivileged.
  mkdir -p /data
  chown -R bun:bun /data
  restore_import
  exec setpriv --reuid bun --regid bun --init-groups "$0" "$@"
fi
restore_import
run_server "$@"
