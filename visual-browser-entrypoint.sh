#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:99
mkdir -p /sessions/facebook /tmp/runtime-pwuser
chmod 700 /tmp/runtime-pwuser /sessions/facebook

Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

sleep 2
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --window-size=1440,900 \
  --user-data-dir=/sessions/facebook \
  'https://www.facebook.com/' >/tmp/chromium.log 2>&1 &

wait -n
