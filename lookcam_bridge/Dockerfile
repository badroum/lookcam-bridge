ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.20
FROM $BUILD_FROM

ARG BUILD_ARCH=aarch64
ARG BUILD_VERSION=0.1.0
ARG MEDIAMTX_VERSION=1.9.3

RUN apk add --no-cache nodejs ffmpeg curl \
 && case "${BUILD_ARCH}" in \
      aarch64) A=arm64v8 ;; amd64) A=amd64 ;; \
      *) echo "unsupported arch ${BUILD_ARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${A}.tar.gz" \
    | tar xz -C /usr/local/bin mediamtx

COPY bridge.cjs mediamtx.yml run.sh /
RUN chmod a+x /run.sh

LABEL \
  io.hass.name="LookCam Bridge" \
  io.hass.description="Local LookCam (PPPP) camera to RTSP bridge, no cloud" \
  io.hass.arch="${BUILD_ARCH}" \
  io.hass.type="addon" \
  io.hass.version="${BUILD_VERSION}" \
  org.opencontainers.image.source="https://github.com/badroum/lookcam-bridge"

CMD [ "/run.sh" ]
