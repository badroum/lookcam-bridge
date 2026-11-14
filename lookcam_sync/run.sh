#!/usr/bin/with-contenv bashio
# Every <interval_minutes>: download new recordings from the camera SD card to /media/boite_aux_lettres/<day>/.
# Then remove clips older than <keep_days> on this host only (the camera and the PC keep theirs).
# Motions (stdin from Home Assistant): the covering segment goes to /media/boite_aux_lettres_mouvements/<day>/,
# kept forever (outside the share the PC empties and outside the purge).
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export OUT_DIR="/media/boite_aux_lettres"
export STATE_FILE="/data/fetched.json"   # clips already fetched (the PC may move them away)
export MOTION_DIR="/media/boite_aux_lettres_mouvements"
export MOTION_QUEUE="/data/motion_queue"  # motion times from Home Assistant, read by sync.cjs (0.5.2)
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
INTERVAL=$(( $(bashio::config 'interval_minutes') * 60 ))
KEEP_DAYS="$(bashio::config 'keep_days')"
mkdir -p "${OUT_DIR}"

bashio::log.info "LookCam Sync ${ADDON_VERSION:-?} started: camera ${CAM_IP}, every $(( INTERVAL / 60 )) min, log level ${LOG_LEVEL}, ${DOWNLOAD_ORDER/_/ }, budget ${MAX_GB} GB, keep ${KEEP_DAYS} days"
bashio::log.info "First round: catch-up of every recording made since the last one fetched (${DOWNLOAD_ORDER/_/ }), then regular rounds; full SD listing once a day"
trap 'bashio::log.info "LookCam Sync stopping"; [ -n "${HTTP_PID:-}" ] && kill "${HTTP_PID}" 2>/dev/null; [ -n "${STDIN_PID:-}" ] && kill "${STDIN_PID}" 2>/dev/null; exit 0' TERM INT

# Motions (0.5.2): Home Assistant sends the motion time (YYYYMMDDHHMMSS, local time) with the service
# hassio.addon_stdin. A background reader queues it at once in ${MOTION_QUEUE}; sync.cjs serves the queue
# between two files and pauses a download in progress for it, so a motion never waits for a round to end.
exec 3<&0
( while read -r LINE <&3; do
    AT="$(printf '%s' "${LINE}" | tr -cd '0-9')"
    if [ "${#AT}" = "14" ]; then
      echo "${AT}" >> "${MOTION_QUEUE}"
      bashio::log.info "Motion at ${AT} queued"
    else
      bashio::log.warning "Ignored stdin input (YYYYMMDDHHMMSS expected): ${LINE}"
    fi
  done ) &
STDIN_PID=$!

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
    ( while true; do node /server.cjs; bashio::log.warning "file server stopped, restarting in 5 s"; sleep 5; done ) &
    HTTP_PID=$!
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
while true; do
  ROUND=$(( ROUND + 1 ))
  if [ "${FULL_LIST}" = "1" ]; then
    bashio::log.info "Round ${ROUND} (start-up catch-up) from ${CAM_IP}"
  else
    bashio::log.info "Round ${ROUND} (regular) from ${CAM_IP}"
  fi
  ROUND_START=$(date +%s)
  if ROUND="${ROUND}" FULL_LIST="${FULL_LIST}" node /sync.cjs; then
    FULL_LIST=0
  else
    bashio::log.warning "Round ${ROUND} ended with an error, retry next round"
  fi
  find "${OUT_DIR}" -type f \( -name '*.mp4' -o -name '*.part' \) -mtime +"${KEEP_DAYS}" -delete
  find "${OUT_DIR}" -mindepth 1 -type d -empty -delete
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
    sleep 5 &
    wait $!
  done
done
