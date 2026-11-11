#!/usr/bin/with-contenv bashio
# Every <interval_minutes>: download new recordings from the camera SD card to /media/boite_aux_lettres/<day>/.
# Then remove clips older than <keep_days> on this host only (the camera and the PC keep theirs).
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export OUT_DIR="/media/boite_aux_lettres"
export STATE_FILE="/data/fetched.json"   # clips already fetched (the PC may move them away)
export MAX_GB="$(bashio::config 'max_gb')"
INTERVAL=$(( $(bashio::config 'interval_minutes') * 60 ))
# Recent files (last interval + 30 min margin) first; a backlog round stops after one interval
export RECENT_MIN=$(( INTERVAL / 60 + 30 ))
export ROUND_MAX_MIN=$(( INTERVAL / 60 ))
KEEP_DAYS="$(bashio::config 'keep_days')"
mkdir -p "${OUT_DIR}"

while true; do
  bashio::log.info "Sync from ${CAM_IP}"
  rc=0
  node /sync.cjs || rc=$?   # keeps working if the shell runs with errexit
  find "${OUT_DIR}" -type f \( -name '*.mp4' -o -name '*.part' \) -mtime +"${KEEP_DAYS}" -delete
  find "${OUT_DIR}" -mindepth 1 -type d -empty -delete
  if [ "${rc}" -eq 3 ]; then
    # catching up: start again soon, the next round takes the recent files first
    bashio::log.info "Backlog left, next sync in 1 min"
    sleep 60
    continue
  fi
  [ "${rc}" -eq 0 ] || bashio::log.warning "sync ended with an error, retry next round"
  bashio::log.info "Next sync in $(( INTERVAL / 60 )) min"
  sleep "${INTERVAL}"
done
