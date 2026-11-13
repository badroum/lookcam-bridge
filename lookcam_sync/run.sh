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

while true; do
  bashio::log.info "Sync from ${CAM_IP}"
  node /sync.cjs || bashio::log.warning "sync ended with an error, retry next round"
  find "${OUT_DIR}" -type f \( -name '*.mp4' -o -name '*.part' \) -mtime +"${KEEP_DAYS}" -delete
  find "${OUT_DIR}" -mindepth 1 -type d -empty -delete
  bashio::log.info "Next sync in $(( INTERVAL / 60 )) min"
  sleep "${INTERVAL}"
done
