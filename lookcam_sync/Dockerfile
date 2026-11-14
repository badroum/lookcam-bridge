ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.20
FROM $BUILD_FROM

ARG BUILD_ARCH
ARG BUILD_VERSION

RUN apk add --no-cache nodejs
ENV ADDON_VERSION=${BUILD_VERSION}

COPY sync.cjs server.cjs run.sh /
RUN chmod a+x /run.sh

LABEL io.hass.name="LookCam Sync" \
      io.hass.description="Downloads LookCam alarm clips from the camera SD card" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.type="addon" \
      io.hass.version="${BUILD_VERSION}"

CMD [ "/run.sh" ]
