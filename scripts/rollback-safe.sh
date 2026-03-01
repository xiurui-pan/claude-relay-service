#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${RELEASE_APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
CONFIG_FILE="${RELEASE_CONFIG_FILE:-${APP_DIR}/config/release.config.json}"

LOCK_DIR="${APP_DIR}/.release.lock"
LOCK_ACQUIRED=false

BACKUP_ID=""
TARGET_REF=""
SKIP_LOCK=false
RESTORE_DATA_OVERRIDE=""

log() {
  printf '[rollback-safe] %s\n' "$*"
}

warn() {
  printf '[rollback-safe] WARN: %s\n' "$*" >&2
}

die() {
  printf '[rollback-safe] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ "${LOCK_ACQUIRED}" == "true" ]]; then
    rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

read_config_value() {
  local key="$1"
  local default_value="${2:-}"
  local value=""

  if [[ -f "${CONFIG_FILE}" ]]; then
    value="$(
      node - "${CONFIG_FILE}" "${key}" <<'NODE' 2>/dev/null || true
const fs = require('fs')
const [file, key] = process.argv.slice(2)
let config = {}
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  process.exit(1)
}

let current = config
for (const part of key.split('.')) {
  if (
    current &&
    typeof current === 'object' &&
    Object.prototype.hasOwnProperty.call(current, part)
  ) {
    current = current[part]
  } else {
    process.exit(1)
  }
}

if (current === null || current === undefined) {
  process.exit(1)
}

if (typeof current === 'object') {
  process.stdout.write(JSON.stringify(current))
} else {
  process.stdout.write(String(current))
}
NODE
    )"
  fi

  if [[ -n "${value}" ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${default_value}"
  fi
}

is_true() {
  case "${1,,}" in
    1 | true | yes | y | on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

to_abs_path() {
  local candidate="$1"
  if [[ -z "${candidate}" ]]; then
    printf ''
    return
  fi
  if [[ "${candidate}" = /* ]]; then
    printf '%s' "${candidate}"
  else
    printf '%s/%s' "${APP_DIR}" "${candidate}"
  fi
}

run_cmd() {
  local cmd="$1"
  log "→ ${cmd}"
  bash -lc "${cmd}"
}

is_service_running() {
  local status_json
  status_json="$(bash -lc "cd \"${APP_DIR}\" && ${SERVICE_STATUS_CMD}" 2>/dev/null || true)"
  if [[ -z "${status_json}" ]]; then
    return 1
  fi
  grep -q '"running":[[:space:]]*true' <<<"${status_json}"
}

wait_for_service_state() {
  local desired="$1"
  local timeout_seconds="$2"
  local start_ts
  start_ts="$(date +%s)"

  while true; do
    local running=false
    if is_service_running; then
      running=true
    fi

    if [[ "${desired}" == "running" && "${running}" == "true" ]]; then
      return 0
    fi
    if [[ "${desired}" == "stopped" && "${running}" == "false" ]]; then
      return 0
    fi

    local now
    now="$(date +%s)"
    if (( now - start_ts >= timeout_seconds )); then
      return 1
    fi

    sleep 1
  done
}

wait_for_health() {
  local timeout_seconds="$1"
  local interval_seconds="$2"
  local start_ts
  start_ts="$(date +%s)"

  while true; do
    local response=""
    response="$(curl -fsS --max-time 3 "${HEALTH_URL}" 2>/dev/null || true)"
    if [[ -n "${response}" ]] && grep -q '"status"[[:space:]]*:[[:space:]]*"healthy"' <<<"${response}"; then
      return 0
    fi

    local now
    now="$(date +%s)"
    if (( now - start_ts >= timeout_seconds )); then
      return 1
    fi

    sleep "${interval_seconds}"
  done
}

restore_tar_to_dir() {
  local archive_path="$1"
  local target_dir="$2"

  if [[ ! -f "${archive_path}" ]]; then
    warn "Archive not found, skip restore: ${archive_path}"
    return
  fi

  mkdir -p "${target_dir}"
  tar -xzf "${archive_path}" -C "${target_dir}"
}

restore_tar_to_exact_path() {
  local archive_path="$1"
  local target_path="$2"

  if [[ ! -f "${archive_path}" ]]; then
    warn "Archive not found, skip restore: ${archive_path}"
    return
  fi

  if [[ -z "${target_path}" || "${target_path}" == "/" ]]; then
    die "Refusing to restore archive to unsafe path: ${target_path}"
  fi

  local parent_dir
  parent_dir="$(dirname "${target_path}")"
  mkdir -p "${parent_dir}"
  rm -rf "${target_path}"
  tar -xzf "${archive_path}" -C "${parent_dir}"
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/rollback-safe.sh --backup <backup_id> [--ref <git_ref>] [--restore-data true|false] [--skip-lock] [--config <path>]

Options:
  --backup <id>           Backup id directory name under backupRoot (required)
  --ref <git_ref>         Target git ref to rollback code to (optional, fallback to manifest oldRef)
  --restore-data <bool>   Whether to restore data/redis archives (optional)
  --skip-lock             Skip lock acquisition (used by release-safe internal rollback)
  --config <path>         Override release config file path
  --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      BACKUP_ID="${2:-}"
      shift 2
      ;;
    --ref)
      TARGET_REF="${2:-}"
      shift 2
      ;;
    --restore-data)
      RESTORE_DATA_OVERRIDE="${2:-}"
      shift 2
      ;;
    --skip-lock)
      SKIP_LOCK=true
      shift
      ;;
    --config)
      CONFIG_FILE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "${BACKUP_ID}" ]] || die "--backup is required"
[[ -f "${CONFIG_FILE}" ]] || die "Config file not found: ${CONFIG_FILE}"

BACKUP_ROOT_RAW="$(read_config_value backupRoot "./backups/releases")"
BACKUP_ROOT="$(to_abs_path "${BACKUP_ROOT_RAW}")"
BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_ID}"

SERVICE_START_CMD="$(read_config_value serviceStartCmd "npm run service:start:daemon")"
SERVICE_STOP_CMD="$(read_config_value serviceStopCmd "npm run service:stop")"
SERVICE_STATUS_CMD="$(read_config_value serviceStatusCmd "node scripts/manage.js status --json")"
INSTALL_DEPENDENCIES_CMD="$(read_config_value installDependenciesCmd "npm ci")"
HEALTH_URL="$(read_config_value healthUrl "http://127.0.0.1:3000/health")"
HEALTH_TIMEOUT_SECONDS="$(read_config_value healthTimeoutSeconds "60")"
HEALTH_INTERVAL_SECONDS="$(read_config_value healthIntervalSeconds "2")"
SERVICE_STOP_TIMEOUT_SECONDS="$(read_config_value serviceStopTimeoutSeconds "45")"
SERVICE_START_TIMEOUT_SECONDS="$(read_config_value serviceStartTimeoutSeconds "45")"
REDIS_DATA_PATH_RAW="$(read_config_value redisDataPath "./redis_data")"
REDIS_DATA_PATH="$(to_abs_path "${REDIS_DATA_PATH_RAW}")"

RESTORE_DATA_ON_ROLLBACK_RAW="$(read_config_value restoreDataOnRollback "false")"
RESTORE_DATA_ON_ROLLBACK="${RESTORE_DATA_ON_ROLLBACK_RAW}"
if [[ -n "${RESTORE_DATA_OVERRIDE}" ]]; then
  RESTORE_DATA_ON_ROLLBACK="${RESTORE_DATA_OVERRIDE}"
fi

[[ -d "${BACKUP_DIR}" ]] || die "Backup directory not found: ${BACKUP_DIR}"

if [[ "${SKIP_LOCK}" != "true" ]]; then
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    LOCK_ACQUIRED=true
  else
    die "Release lock exists at ${LOCK_DIR}, rollback aborted"
  fi
fi

MANIFEST_PATH="${BACKUP_DIR}/manifest.json"
if [[ -f "${MANIFEST_PATH}" && -z "${TARGET_REF}" ]]; then
  TARGET_REF="$(
    node - "${MANIFEST_PATH}" <<'NODE' 2>/dev/null || true
const fs = require('fs')
const file = process.argv[2]
try {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (manifest.oldRef) {
    process.stdout.write(String(manifest.oldRef))
  }
} catch {}
NODE
  )"
fi

[[ -n "${TARGET_REF}" ]] || die "No rollback git ref provided and manifest.oldRef missing"

log "Rollback start"
log "Backup: ${BACKUP_ID}"
log "Target ref: ${TARGET_REF}"

if is_service_running; then
  run_cmd "cd \"${APP_DIR}\" && ${SERVICE_STOP_CMD}" || warn "Service stop command failed, continue with state check"
  if ! wait_for_service_state "stopped" "${SERVICE_STOP_TIMEOUT_SECONDS}"; then
    die "Service did not stop within ${SERVICE_STOP_TIMEOUT_SECONDS}s"
  fi
else
  log "Service already stopped"
fi

run_cmd "cd \"${APP_DIR}\" && git checkout \"${TARGET_REF}\""
run_cmd "cd \"${APP_DIR}\" && ${INSTALL_DEPENDENCIES_CMD}"

if [[ -f "${BACKUP_DIR}/env/.env" ]]; then
  cp "${BACKUP_DIR}/env/.env" "${APP_DIR}/.env"
  log "Restored .env"
fi

restore_tar_to_dir "${BACKUP_DIR}/config.tar.gz" "${APP_DIR}"
log "Restored config archive"

if is_true "${RESTORE_DATA_ON_ROLLBACK}"; then
  restore_tar_to_dir "${BACKUP_DIR}/data.tar.gz" "${APP_DIR}"
  log "Restored data archive"
  restore_tar_to_exact_path "${BACKUP_DIR}/redis.tar.gz" "${REDIS_DATA_PATH}"
  log "Restored redis archive"
else
  log "Data restore skipped (restoreDataOnRollback=false)"
fi

run_cmd "cd \"${APP_DIR}\" && ${SERVICE_START_CMD}"
if ! wait_for_service_state "running" "${SERVICE_START_TIMEOUT_SECONDS}"; then
  die "Service did not reach running state in ${SERVICE_START_TIMEOUT_SECONDS}s"
fi

if ! wait_for_health "${HEALTH_TIMEOUT_SECONDS}" "${HEALTH_INTERVAL_SECONDS}"; then
  die "Health check failed after rollback (${HEALTH_URL})"
fi

log "Rollback completed successfully"
