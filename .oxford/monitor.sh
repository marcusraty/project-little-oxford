#!/usr/bin/env bash
cd "$(dirname "$0")"
FEED=".monitor_feed"
HEARTBEAT=".monitor_heartbeat"
touch "$FEED"
(while true; do date +%s > "$HEARTBEAT"; sleep 2; done) &
trap "kill $! 2>/dev/null; rm -f $HEARTBEAT" EXIT
echo "little-oxford monitor started — watching for rule matches"
tail -n 0 -f "$FEED" | while IFS= read -r line; do
  echo "$line"
done
