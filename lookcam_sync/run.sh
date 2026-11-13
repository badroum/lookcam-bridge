#!/usr/bin/with-contenv bashio
# Every <interval_minutes>: download new recordings from the camera SD card to /media/boite_aux_lettres/<day>/.
# Then remove clips older than <keep_days> on this host only (the camera and the PC keep theirs).
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export OUT_DIR="/media/boite_aux_lettres"
export STATE_FILE="/data/fetched.json"   # clips already fetched (the PC may move them away)
export MAX_GB="$(bashio::config 'max_gb')"
# debug | info | warning | error (optional option: info when absent from an older configuration)
LOG_LEVEL="info"
if bashio::config.has_value 'log_level'; then LOG_LEVEL="$(bashio::config 'log_level')"; fi
export LOG_LEVEL
bashio::log.level "${LOG_LEVEL}"
INTERVAL=$(( $(bashio::config 'interval_minutes') * 60 ))
KEEP_DAYS="$(bashio::config 'keep_days')"
mkdir -p "${OUT_DIR}"

bashio::log.info "LookCam Sync ${ADDON_VERSION:-?} started: camera ${CAM_IP}, every $(( INTERVAL / 60 )) min, log level ${LOG_LEVEL}, budget ${MAX_GB} GB, keep ${KEEP_DAYS} days"
bashio::log.info "First round: full catch-up of every missing recording, then regular rounds"
trap 'bashio::log.info "LookCam Sync stopping"; exit 0' TERM INT

# First round after start-up: full SD listing, every missing recording (oldest first).
# Then the regular rounds every <interval_minutes>, incremental (plus one full listing a day).
FULL_LIST=1
ROUND=0
while true; do
  ROUND=$(( ROUND + 1 ))
  if [ "${FULL_LIST}" = "1" ]; then
    bashio::log.info "Round ${ROUND} (start-up, full catch-up) from ${CAM_IP}"
  else
    bashio::log.info "Round ${ROUND} (regular) from ${CAM_IP}"
  fi
  if FULL_LIST="${FULL_LIST}" node /sync.cjs; then
    FULL_LIST=0
  else
    bashio::log.warning "Round ${ROUND} ended with an error, retry next round"
  fi
  find "${OUT_DIR}" -type f \( -name '*.mp4' -o -name '*.part' \) -mtime +"${KEEP_DAYS}" -delete
  find "${OUT_DIR}" -mindepth 1 -type d -empty -delete
  bashio::log.info "Next sync at $(date -d "@$(( $(date +%s) + INTERVAL ))" '+%H:%M') (in $(( INTERVAL / 60 )) min)"
  sleep "${INTERVAL}" &
  wait $!
done
