# Sandboxed browser for sun-harness: Chromium on a virtual X display, viewable and controllable
# through noVNC, automatable through CDP (forwarded by socat because Chromium binds DevTools to loopback).
FROM debian:bookworm-slim

ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify socat fluxbox fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 browser && mkdir -p /profile && chown browser /profile
COPY entrypoint.sh /usr/local/bin/sun-browser
RUN chmod +x /usr/local/bin/sun-browser

USER browser
ENV DISPLAY=:99 SCREEN=1280x800x24
# 9223: CDP (socat → Chromium 127.0.0.1:9222) · 6080: noVNC web client
EXPOSE 9223 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sun-browser"]
