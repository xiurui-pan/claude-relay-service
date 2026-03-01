#!/usr/bin/env bash
set -eEuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${RELEASE_CONFIG_FILE:-${APP_DIR}/config/release.config.json}"

LOCK_DIR="${APP_DIR}/.release.lock"
LOCK_ACQUIRED=false
BACKUP_ID=""
BACKUP_DIR=""
OLD_REF=""
TARGET_REF=""
SKIP_INSTALL=false
NO_ROLLBACK=false
FAILED=false

log() {
  printf '[release-safe] %s\n' "$*"
}

warn() {
  printf '[release-safe] WARN: %s\n' "$*" >&2
}

die() {
  printf '[release-safe] ERROR: %s\n' "$*" >&2
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

backup_tar_if_exists() {
  local relative_path="$1"
  local archive_path="$2"

  if [[ -e "${APP_DIR}/${relative_path}" ]]; then
    tar -czf "${archive_path}" -C "${APP_DIR}" "${relative_path}"
    log "Backed up ${relative_path}"
  else
    warn "Path not found, backup skipped: ${relative_path}"
  fi
}

backup_redis_snapshot() {
  local backup_ok=false

  if [[ -n "${REDIS_DATA_PATH}" && -d "${REDIS_DATA_PATH}" && -r "${REDIS_DATA_PATH}" && -x "${REDIS_DATA_PATH}" ]]; then
    if tar -czf "${BACKUP_DIR}/redis.tar.gz" -C "$(dirname "${REDIS_DATA_PATH}")" "$(basename "${REDIS_DATA_PATH}")"; then
      log "Backed up redis data path: ${REDIS_DATA_PATH}"
      backup_ok=true
    else
      warn "Failed to archive redis data path: ${REDIS_DATA_PATH}"
    fi
  else
    warn "Redis data path not readable or missing: ${REDIS_DATA_PATH}"
  fi

  if [[ "${backup_ok}" == "false" && -n "${REDIS_RDB_BACKUP_CMD}" ]]; then
    local rdb_output="${BACKUP_DIR}/redis.rdb"
    local rendered_cmd="${REDIS_RDB_BACKUP_CMD//__OUTPUT__/${rdb_output}}"
    log "Falling back to redis-cli RDB backup"
    if run_cmd "${rendered_cmd}"; then
      if [[ -s "${rdb_output}" ]]; then
        log "Backed up redis snapshot via rdb export: ${rdb_output}"
        backup_ok=true
      else
        warn "RDB backup command succeeded but output file missing/empty: ${rdb_output}"
      fi
    else
      warn "RDB backup command failed"
    fi
  fi

  if [[ "${backup_ok}" == "false" ]]; then
    if is_true "${REQUIRE_REDIS_BACKUP}"; then
      die "Redis backup is required but both filesystem and rdb export backups failed"
    fi
    warn "Redis backup skipped"
  fi
}

write_manifest() {
  local manifest_path="$1"
  local target_resolved="$2"
  cat >"${manifest_path}" <<EOF
{
  "backupId": "${BACKUP_ID}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "oldRef": "${OLD_REF}",
  "targetRefInput": "${TARGET_REF}",
  "targetRefResolved": "${target_resolved}",
  "configFile": "${CONFIG_FILE}",
  "healthUrl": "${HEALTH_URL}"
}
EOF
}

cleanup_old_backups() {
  local keep_count="$1"
  mkdir -p "${BACKUP_ROOT}"
  mapfile -t backups < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
  if (( ${#backups[@]} <= keep_count )); then
    return
  fi
  for ((i = keep_count; i < ${#backups[@]}; i++)); do
    rm -rf "${BACKUP_ROOT:?}/${backups[$i]}"
    log "Pruned old backup: ${backups[$i]}"
  done
}

on_error() {
  local exit_code=$?
  trap - ERR
  FAILED=true
  warn "Release failed with code ${exit_code}"

  if [[ "${NO_ROLLBACK}" == "true" ]]; then
    warn "Auto rollback disabled by flag"
    exit "${exit_code}"
  fi

  if ! is_true "${AUTO_ROLLBACK}"; then
    warn "Auto rollback disabled in config"
    exit "${exit_code}"
  fi

  if [[ -z "${BACKUP_ID}" || -z "${OLD_REF}" ]]; then
    warn "Rollback skipped because backup metadata is incomplete"
    exit "${exit_code}"
  fi

  warn "Triggering automatic rollback (backup=${BACKUP_ID}, ref=${OLD_REF})"
  if bash "${APP_DIR}/scripts/rollback-safe.sh" \
    --backup "${BACKUP_ID}" \
    --ref "${OLD_REF}" \
    --skip-lock \
    --config "${CONFIG_FILE}" \
    --restore-data "${RESTORE_DATA_ON_ROLLBACK}"; then
    warn "Automatic rollback succeeded"
  else
    warn "Automatic rollback failed, manual recovery required"
  fi

  exit "${exit_code}"
}
trap on_error ERR

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release-safe.sh [--ref <git_ref>] [--skip-install] [--no-rollback] [--config <path>]

Options:
  --ref <git_ref>    Target release ref/tag/sha (optional; defaultReleaseRef in config)
  --skip-install     Skip dependency install command
  --no-rollback      Disable automatic rollback on failure
  --config <path>    Override release config file path
  --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      TARGET_REF="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    --no-rollback)
      NO_ROLLBACK=true
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

[[ -f "${CONFIG_FILE}" ]] || die "Config file not found: ${CONFIG_FILE}"

if [[ -z "${TARGET_REF}" ]]; then
  TARGET_REF="$(read_config_value defaultReleaseRef "main")"
fi
[[ -n "${TARGET_REF}" ]] || die "Target ref is empty"

GIT_REMOTE="$(read_config_value gitRemote "origin")"
PRECHECK_CLEAN_GIT="$(read_config_value preflightRequireCleanGit "true")"
HEALTH_URL="$(read_config_value healthUrl "http://127.0.0.1:3000/health")"
HEALTH_TIMEOUT_SECONDS="$(read_config_value healthTimeoutSeconds "60")"
HEALTH_INTERVAL_SECONDS="$(read_config_value healthIntervalSeconds "2")"
SERVICE_STOP_TIMEOUT_SECONDS="$(read_config_value serviceStopTimeoutSeconds "45")"
SERVICE_START_TIMEOUT_SECONDS="$(read_config_value serviceStartTimeoutSeconds "45")"
BACKUP_ROOT_RAW="$(read_config_value backupRoot "./backups/releases")"
BACKUP_ROOT="$(to_abs_path "${BACKUP_ROOT_RAW}")"
RETAIN_BACKUPS="$(read_config_value retainBackups "7")"
REDIS_DATA_PATH_RAW="$(read_config_value redisDataPath "./redis_data")"
REDIS_DATA_PATH="$(to_abs_path "${REDIS_DATA_PATH_RAW}")"
REQUIRE_REDIS_BACKUP="$(read_config_value requireRedisBackup "false")"
REDIS_RDB_BACKUP_CMD="$(read_config_value redisRdbBackupCmd "")"
RESTORE_DATA_ON_ROLLBACK="$(read_config_value restoreDataOnRollback "false")"
SERVICE_START_CMD="$(read_config_value serviceStartCmd "npm run service:start:daemon")"
SERVICE_STOP_CMD="$(read_config_value serviceStopCmd "npm run service:stop")"
SERVICE_STATUS_CMD="$(read_config_value serviceStatusCmd "node scripts/manage.js status --json")"
INSTALL_DEPENDENCIES_CMD="$(read_config_value installDependenciesCmd "npm ci")"
AUTO_ROLLBACK="$(read_config_value autoRollback "true")"

if mkdir "${LOCK_DIR}" 2>/dev/null; then
  LOCK_ACQUIRED=true
else
  die "Release lock exists at ${LOCK_DIR}, another release may be running"
fi

log "Release start"
log "Target ref: ${TARGET_REF}"
log "Config: ${CONFIG_FILE}"

if is_true "${PRECHECK_CLEAN_GIT}"; then
  if [[ -n "$(git -C "${APP_DIR}" status --porcelain)" ]]; then
    die "Git working tree is dirty. Commit/stash changes or set preflightRequireCleanGit=false."
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required for health checks"
fi
if ! command -v node >/dev/null 2>&1; then
  die "node is required"
fi

OLD_REF="$(git -C "${APP_DIR}" rev-parse HEAD)"
run_cmd "cd \"${APP_DIR}\" && git fetch \"${GIT_REMOTE}\" --tags --prune"

TARGET_RESOLVED_REF="$(
  git -C "${APP_DIR}" rev-parse --verify "${TARGET_REF}^{commit}" 2>/dev/null ||
    git -C "${APP_DIR}" rev-parse --verify "refs/remotes/${GIT_REMOTE}/${TARGET_REF}^{commit}" 2>/dev/null ||
    true
)"
[[ -n "${TARGET_RESOLVED_REF}" ]] || die "Unable to resolve target ref: ${TARGET_REF}"

BACKUP_ID="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_ID}"
mkdir -p "${BACKUP_DIR}/env"

if [[ -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env" "${BACKUP_DIR}/env/.env"
  log "Backed up .env"
else
  warn ".env not found, skip backup"
fi

backup_tar_if_exists "config" "${BACKUP_DIR}/config.tar.gz"
backup_tar_if_exists "data" "${BACKUP_DIR}/data.tar.gz"

backup_redis_snapshot

write_manifest "${BACKUP_DIR}/manifest.json" "${TARGET_RESOLVED_REF}"
log "Backup completed: ${BACKUP_DIR}"

if is_service_running; then
  run_cmd "cd \"${APP_DIR}\" && ${SERVICE_STOP_CMD}" || warn "Service stop command failed, continue with state check"
  if ! wait_for_service_state "stopped" "${SERVICE_STOP_TIMEOUT_SECONDS}"; then
    die "Service did not stop within ${SERVICE_STOP_TIMEOUT_SECONDS}s"
  fi
else
  log "Service already stopped"
fi

run_cmd "cd \"${APP_DIR}\" && git checkout \"${TARGET_RESOLVED_REF}\""

if [[ "${SKIP_INSTALL}" == "false" ]]; then
  run_cmd "cd \"${APP_DIR}\" && ${INSTALL_DEPENDENCIES_CMD}"
else
  log "Dependency install skipped by flag"
fi

run_cmd "cd \"${APP_DIR}\" && ${SERVICE_START_CMD}"
if ! wait_for_service_state "running" "${SERVICE_START_TIMEOUT_SECONDS}"; then
  die "Service did not reach running state within ${SERVICE_START_TIMEOUT_SECONDS}s"
fi

if ! wait_for_health "${HEALTH_TIMEOUT_SECONDS}" "${HEALTH_INTERVAL_SECONDS}"; then
  die "Health check failed (${HEALTH_URL})"
fi

cleanup_old_backups "${RETAIN_BACKUPS}"
trap - ERR
FAILED=false
log "Release completed successfully"
