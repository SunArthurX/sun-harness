#!/bin/sh
# Xvfb (virtual display) → fluxbox (window manager) → Chromium (CDP on loopback :9222)
# → socat (CDP on 0.0.0.0:9223) → x11vnc (VNC :5900) → websockify/noVNC (web on :6080).
set -e
Xvfb :99 -screen 0 "${SCREEN:-1280x800x24}" -nolisten tcp &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
fluxbox >/dev/null 2>&1 &
chromium \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage --no-sandbox \
  --user-data-dir=/profile --remote-debugging-port=9222 --remote-allow-origins='*' \
  --window-position=0,0 --window-size="$(echo "${SCREEN:-1280x800x24}" | cut -dx -f1),$(echo "${SCREEN:-1280x800x24}" | cut -dx -f2)" \
  about:blank >/tmp/chromium.log 2>&1 &
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
exec websockify --web /usr/share/novnc 6080 localhost:5900
