#!/usr/bin/with-contenv bashio
# Password comes from the add-on options (type: password), never written to disk or logs.
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export STATE="$(bashio::config 'state')"
export RTSP_URL="rtsp://127.0.0.1:8554/v99"

bashio::log.info "Starting MediaMTX (RTSP :8554/v99)"
mediamtx /mediamtx.yml &

bashio::log.info "Starting LookCam bridge for ${CAM_IP} (state ${STATE})"
exec node /bridge.cjs
