#!/usr/bin/with-contenv bashio
# Password comes from the add-on options (type: password), never written to disk or logs.
export CAM_IP="$(bashio::config 'camera_ip')"
export CAM_PASSWORD="$(bashio::config 'password')"
export STATE="$(bashio::config 'state')"
export RTSP_URL="rtsp://127.0.0.1:8554/v99"

RECORD="$(bashio::config 'record')"
RETENTION="$(bashio::config 'retention_days')"
SEGMENT="$(bashio::config 'segment_minutes')"

# MediaMTX config generated at start. Recording is a plain stream copy (no decoding):
# fMP4 segments in /share/lookcam/v99/, purged after the retention period.
CONF=/tmp/mediamtx.yml
cp /mediamtx.yml "$CONF"
if bashio::var.true "${RECORD}"; then
  mkdir -p /share/lookcam
  cat >> "$CONF" <<EOT
pathDefaults:
  record: yes
  recordPath: /share/lookcam/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordPartDuration: 1s
  recordSegmentDuration: ${SEGMENT}m
  recordDeleteAfter: $((RETENTION * 24))h
EOT
  bashio::log.info "Recording to /share/lookcam (segments ${SEGMENT} min, kept ${RETENTION} days)"
fi

bashio::log.info "Starting MediaMTX (RTSP :8554/v99)"
mediamtx "$CONF" &

bashio::log.info "Starting LookCam bridge for ${CAM_IP} (state ${STATE})"
exec node /bridge.cjs
