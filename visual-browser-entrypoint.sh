#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
mkdir -p /sessions/facebook /tmp/runtime-pwuser
chmod 700 /tmp/runtime-pwuser /sessions/facebook
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

sleep 2
CHROME_BIN="${CHROME_BIN:-$(find /ms-playwright -type f -path '*/chrome-linux64/chrome' -perm -111 -print -quit)}"
if [[ -z "$CHROME_BIN" || ! -x "$CHROME_BIN" ]]; then
  echo 'Chromium executable not found under /ms-playwright' >&2
  exit 1
fi
"$CHROME_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --window-size=1440,900 \
  --user-data-dir=/sessions/facebook \
  'https://www.facebook.com/' >/tmp/chromium.log 2>&1 &

wait -n
