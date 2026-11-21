#!/usr/bin/with-contenv bashio
# Every <interval_minutes>: download new recordings from the camera SD card to <storage>/boite_aux_lettres/<day>/.
# Then remove clips older than <keep_days> on this host only (the camera and the PC keep theirs).
# Motions (stdin from Home Assistant): the covering segment goes to /media/boite_aux_lettres_mouvements/<day>/,
# kept forever (outside the share the PC empties and outside the purge).
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export STATE_FILE="/data/fetched.json"   # clips already fetched (the PC may move them away)
export MOTION_QUEUE="/data/motion_queue"  # motion times from Home Assistant, read by sync.cjs (0.5.2)
export CAMERA_DIR="/data/camera"          # camera settings: last read, backups, pending request (0.5.7)
CAMERA_REQUEST="${CAMERA_DIR}/request.json"
mkdir -p "${CAMERA_DIR}"
export MAX_GB="$(bashio::config 'max_gb')"
# debug | info | warning | error (optional option: info when absent from an older configuration)
LOG_LEVEL="info"
if bashio::config.has_value 'log_level'; then LOG_LEVEL="$(bashio::config 'log_level')"; fi
export LOG_LEVEL
# oldest_first (default: the SD card overwrites its oldest files first) | newest_first
DOWNLOAD_ORDER="oldest_first"
if bashio::config.has_value 'download_order'; then DOWNLOAD_ORDER="$(bashio::config 'download_order')"; fi
export DOWNLOAD_ORDER
bashio::log.level "${LOG_LEVEL}"

# Storage (0.5.6), option "storage":
#   internal (default): /media of Home Assistant, on the Pi's own SD card;
#   usb: the first external disk Home Assistant mounted under /media/<name> (or /share/<name>);
#   custom: the folder given in "storage_path", under /media or /share.
# The recordings go to <base>/boite_aux_lettres/<day>/. The motion segments stay in
# /media/boite_aux_lettres_mouvements/<day>/ whatever the storage: Home Assistant links to them as
# media-source://media_source/local/boite_aux_lettres_mouvements/... (notification, dashboard).
# Files already in another location are left where they are.
free_mb() { df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4 }' || true; }
# Mount points below /media and /share other than those two folders (USB disks, network shares).
list_mounts() {
  awk '$2 ~ "^/(media|share)/" && $3 !~ "^(tmpfs|proc|sysfs|devtmpfs|overlay)$" { gsub("\\\\040", " ", $2); print $2 "|" $1 "|" $3 }' /proc/mounts 2>/dev/null || true
}
STORAGE="internal"
if bashio::config.has_value 'storage'; then STORAGE="$(bashio::config 'storage')"; fi
STORAGE_PATH=""
if bashio::config.has_value 'storage_path'; then STORAGE_PATH="$(bashio::config 'storage_path')"; fi
MOUNTS="$(list_mounts)"
bashio::log.info "Storage seen by the add-on: /media (internal, $(free_mb /media) MB free)"
if [ -n "${MOUNTS}" ]; then
  while IFS='|' read -r MP DEV FS; do
    [ -n "${MP}" ] && bashio::log.info "Storage seen by the add-on: ${MP} (${DEV}, ${FS}, $(free_mb "${MP}") MB free)"
  done <<< "${MOUNTS}"
else
  bashio::log.info "Storage seen by the add-on: no external disk under /media or /share"
fi
BASE="/media"
case "${STORAGE}" in
  usb)
    USB_MP="$(printf '%s\n' "${MOUNTS}" | awk -F'|' '$2 ~ "^/dev/(sd|nvme|mmcblk[1-9])" { print $1; exit }' || true)"
    if [ -n "${USB_MP}" ]; then
      BASE="${USB_MP}"
    else
      bashio::log.warning "storage: usb, but no USB disk is mounted under /media or /share: recordings stay on the internal storage (/media). Check Settings > System > Storage in Home Assistant."
    fi
    ;;
  custom)
    case "${STORAGE_PATH}" in
      /media|/media/*|/share|/share/*)
        if mkdir -p "${STORAGE_PATH}" 2>/dev/null && [ -w "${STORAGE_PATH}" ]; then
          BASE="${STORAGE_PATH%/}"
        else
          bashio::log.warning "storage_path ${STORAGE_PATH} cannot be written: recordings stay on /media"
        fi
        ;;
      *)
        bashio::log.warning "storage_path must be under /media or /share (got \"${STORAGE_PATH}\"): recordings stay on /media"
        ;;
    esac
    ;;
esac
export OUT_DIR="${BASE}/boite_aux_lettres"
export MOTION_DIR="/media/boite_aux_lettres_mouvements"
bashio::log.info "Storage: ${STORAGE} -> ${OUT_DIR} ($(free_mb "${BASE}") MB free)"
LAST_BASE_FILE="/data/storage_base.txt"
LAST_BASE="$(cat "${LAST_BASE_FILE}" 2>/dev/null || true)"
if [ -n "${LAST_BASE}" ] && [ "${LAST_BASE}" != "${BASE}" ]; then
  LEFT="$(find "${LAST_BASE}/boite_aux_lettres" -type f -name '*.mp4' 2>/dev/null | wc -l || true)"
  bashio::log.warning "Storage changed from ${LAST_BASE} to ${BASE}: ${LEFT:-0} recording(s) stay in the old place (not moved, not deleted)"
fi
echo "${BASE}" > "${LAST_BASE_FILE}" || true
INTERVAL=$(( $(bashio::config 'interval_minutes') * 60 ))
KEEP_DAYS="$(bashio::config 'keep_days')"
mkdir -p "${OUT_DIR}" "${MOTION_DIR}"
# Memory (0.5.5): the Pi 3 has 1 GB for Home Assistant and every add-on. Cap the Node heaps so that a
# leak or a big listing ends in a clean error (retried next round) rather than in the kernel killing us.
export NODE_OPTIONS="--max-old-space-size=128"

bashio::log.info "LookCam Sync ${ADDON_VERSION:-?} started: camera ${CAM_IP}, every $(( INTERVAL / 60 )) min, log level ${LOG_LEVEL}, ${DOWNLOAD_ORDER/_/ }, budget ${MAX_GB} GB, keep ${KEEP_DAYS} days"
bashio::log.info "First round: catch-up of every recording made since the last one fetched (${DOWNLOAD_ORDER/_/ }), then regular rounds; full SD listing once a day"
trap 'bashio::log.info "LookCam Sync stopping"; [ -n "${HTTP_PID:-}" ] && kill "${HTTP_PID}" 2>/dev/null; [ -n "${STDIN_PID:-}" ] && kill "${STDIN_PID}" 2>/dev/null; exit 0' TERM INT

# Motions (0.5.2): Home Assistant sends the motion time (YYYYMMDDHHMMSS, local time) with the service
# hassio.addon_stdin. A background reader queues it at once in ${MOTION_QUEUE}; sync.cjs serves the queue
# between two files and pauses a download in progress for it, so a motion never waits for a round to end.
# Camera settings (0.5.7): a JSON object, e.g. input {"camera": {"carte": {"openRes": 1}}} or
# {"camera": "read"}, goes to ${CAMERA_REQUEST} (the motion queue keeps digits only and would lose it).
# sync.cjs checks it before sending anything.
exec 3<&0
# Background loops (0.5.5): bashio turns on errexit, which a subshell inherits; a killed child would end
# the loop silently. "set +e" keeps these loops alive whatever happens to the commands they run.
( set +e
  while read -r LINE <&3; do
    case "${LINE}" in
      *"{"*)
        if printf '%s\n' "${LINE}" > "${CAMERA_REQUEST}.tmp" && mv -f "${CAMERA_REQUEST}.tmp" "${CAMERA_REQUEST}"; then
          bashio::log.info "Camera settings request queued (checked before sending)"
        fi
        continue
        ;;
    esac
    AT="$(printf '%s' "${LINE}" | tr -cd '0-9')"
    if [ "${#AT}" = "14" ]; then
      echo "${AT}" >> "${MOTION_QUEUE}"
      bashio::log.info "Motion at ${AT} queued"
    else
      bashio::log.warning "Ignored stdin input (YYYYMMDDHHMMSS expected): ${LINE}"
    fi
  done ) &
STDIN_PID=$!

# File server for the PC, restarted 5 s after any exit (crash, out of memory...). Run under "set +e":
# with errexit, a killed node used to end this loop without a word (15/11, 07:01).
start_file_server() {
  ( set +e
    while true; do
      node --max-old-space-size=48 /server.cjs
      RC=$?
      bashio::log.warning "file server stopped (exit ${RC}$( [ "${RC}" = "137" ] && echo ", killed: out of memory?" )), restarting in 5 s"
      sleep 5
    done ) &
  HTTP_PID=$!
}

# Free memory of the host, in MB (MemAvailable), empty if unknown.
mem_available_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || true; }

# How the PC fetches the recordings (option pc_transfer): samba (default: the Samba add-on shares /media)
# or http (built-in file server below, in place of the Samba add-on; needs http_token, 16+ characters).
PC_TRANSFER="samba"
if bashio::config.has_value 'pc_transfer'; then PC_TRANSFER="$(bashio::config 'pc_transfer')"; fi
export HTTP_PORT="$(bashio::config 'http_port')"
export HTTP_TOKEN=""
if bashio::config.has_value 'http_token'; then HTTP_TOKEN="$(bashio::config 'http_token')"; fi
if [ "${PC_TRANSFER}" = "http" ]; then
  if [ "${#HTTP_TOKEN}" -ge 16 ]; then
    bashio::log.info "PC transfer: built-in file server on port ${HTTP_PORT} (the Samba add-on can be stopped)"
    start_file_server
  else
    bashio::log.warning "PC transfer http: http_token missing or shorter than 16 characters, file server not started"
  fi
else
  bashio::log.info "PC transfer: Samba add-on (file server off)"
fi

# First round after start-up: full SD listing, every missing recording (oldest first).
# Then the regular rounds every <interval_minutes>, incremental (plus one full listing a day).
FULL_LIST=1
ROUND=0
FAILED_ROUNDS=0
FAILED_SINCE=""
while true; do
  ROUND=$(( ROUND + 1 ))
  if [ "${FULL_LIST}" = "1" ]; then
    bashio::log.info "Round ${ROUND} (start-up catch-up) from ${CAM_IP}"
  else
    bashio::log.info "Round ${ROUND} (regular) from ${CAM_IP}"
  fi
  MEM_MB="$(mem_available_mb)"
  if [ -n "${MEM_MB}" ] && [ "${MEM_MB}" -lt 150 ]; then
    bashio::log.warning "Low memory on the host: ${MEM_MB} MB available (the system may kill a process)"
  fi
  ROUND_START=$(date +%s)
  if ROUND="${ROUND}" FULL_LIST="${FULL_LIST}" node /sync.cjs; then
    FULL_LIST=0
    if [ "${FAILED_ROUNDS}" -gt 0 ]; then
      bashio::log.info "Camera back after ${FAILED_ROUNDS} failed round(s) since ${FAILED_SINCE}"
    fi
    FAILED_ROUNDS=0
  else
    RC=$?
    FAILED_ROUNDS=$(( FAILED_ROUNDS + 1 ))
    [ "${FAILED_ROUNDS}" = "1" ] && FAILED_SINCE="$(date '+%d/%m %H:%M')"
    if [ "${RC}" = "137" ]; then
      bashio::log.warning "Round ${ROUND} was killed (out of memory?), retry next round"
    else
      bashio::log.warning "Round ${ROUND} ended with an error, retry next round"
    fi
    if [ "${FAILED_ROUNDS}" -ge 3 ]; then
      bashio::log.warning "${FAILED_ROUNDS} rounds in a row without the camera since ${FAILED_SINCE}: check its power and Wi-Fi (Livebox: does it still have the address ${CAM_IP}?)"
    fi
  fi
  find "${OUT_DIR}" -type f \( -name '*.mp4' -o -name '*.part' \) -mtime +"${KEEP_DAYS}" -delete || true
  find "${OUT_DIR}" -mindepth 1 -type d -empty -delete || true
  # A long round (a catch-up) only fetches what was listed when it started: the recordings made meanwhile
  # wait for the next round. When the round lasted more than half the interval, start the next one at once
  # (after 1 min) instead of waiting the whole interval; regular short rounds keep the interval.
  ROUND_S=$(( $(date +%s) - ROUND_START ))
  if [ "${ROUND_S}" -gt $(( INTERVAL / 2 )) ]; then
    NEXT=$(( $(date +%s) + 60 ))
    bashio::log.info "Round ${ROUND} took $(( ROUND_S / 60 )) min: recordings made meanwhile are fetched now, next sync at $(date -d "@${NEXT}" '+%H:%M') (in 1 min)"
  else
    NEXT=$(( $(date +%s) + INTERVAL ))
    bashio::log.info "Next sync at $(date -d "@${NEXT}" '+%H:%M') (in $(( INTERVAL / 60 )) min)"
  fi
  STATUS_NEXT="${NEXT}" node /sync.cjs || true
  # Wait for the next round, serving queued motions meanwhile (checked every 5 s).
  while [ "$(date +%s)" -lt "${NEXT}" ]; do
    if [ -s "${MOTION_QUEUE}" ]; then
      MOTION_SERVE=1 node /sync.cjs || bashio::log.warning "Motion: segment not fetched"
    fi
    # Camera settings request (stdin, PC), after the motions.
    if [ -s "${CAMERA_REQUEST}" ] && [ ! -s "${MOTION_QUEUE}" ] && [ "$(date +%s)" -ge "${CAMERA_RETRY_AT:-0}" ]; then
      if ! CAMERA_APPLY=1 node /sync.cjs; then
        CAMERA_RETRY_AT=$(( $(date +%s) + 300 ))
        bashio::log.warning "Camera settings: camera not reached, request kept, next try in 5 min (or at the next round)"
      fi
    fi
    # Restart the file server loop if it died anyway (killed with its loop).
    if [ -n "${HTTP_PID:-}" ] && ! kill -0 "${HTTP_PID}" 2>/dev/null; then
      bashio::log.warning "file server loop gone, starting it again"
      start_file_server
    fi
    sleep 5 &
    # "|| true": with errexit, a killed sleep used to stop the whole add-on (15/11, 07:02).
    wait $! || true
  done
done
