#!/bin/bash
# Full local test of the Smelliest Pilgrim server. No Cloudflare account needed:
# a fresh local D1, `wrangler dev --local`, the real watch sender replaying a
# day of memos, then the memo page in headless Chrome.
# Needs: Node 20+, ffmpeg, JDK 17 (for the synthetic day), Chrome/Chromium.
# MEMOS=<dir> replays your own day folder from the phone app instead.
set -e
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
export TOKEN=local-test-token-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
T=$(mktemp -d)
if [ -z "$MEMOS" ]; then
  echo "== synthetic day (generated tones, made with the phone app's own Ogg writer)"
  [ -x "${JAVA_HOME:-/nonexistent}/bin/javac" ] || JAVA_HOME=$HOME/jdk17; export PATH=$JAVA_HOME/bin:$PATH
  javac -nowarn -d "$T/cls" $(find ../android/src/com/smilingpilgrim/watchmemo/core -name '*.java') ../android/test/TestMain.java 2>&1 | grep -v -i warning || true
  python3 test/make_day.py "$T/day" "$T/cls"; MEMOS=$T/day
fi
printf 'TOKEN=%s\n' "$TOKEN" > .dev.vars
rm -rf .wrangler/state test-output && mkdir -p test-output
npx wrangler d1 migrations apply smelliest-pilgrim --local > "$T/migrate.log" 2>&1
PORT=8797; export SERVER=http://127.0.0.1:$PORT
npx wrangler dev --local --port $PORT --ip 127.0.0.1 > "$T/dev.log" 2>&1 & DEV=$!
trap 'kill $DEV 2>/dev/null; pkill -f "wrangler dev --local --port $PORT" 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 100); do grep -q "Ready on" "$T/dev.log" && break; sleep 0.2; done
mkdir -p "$T/u"; for f in ../watch/utils/*.js; do sed -E "s#from '\./([a-z]+)'#from './\1.js'#" "$f" > "$T/u/$(basename "$f")"; done
echo '{"type":"module"}' > "$T/u/package.json"
echo "== replay the memos through the watch sender + Side Service relay into the Worker"
node test/replay.mjs "$T/u" "$MEMOS" test-output
echo "== decode check (ffmpeg, Ogg CRCs enforced)"
for f in test-output/*.ogg; do printf '  %s %ss ' "$(basename "$f")" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"; ffmpeg -v error -err_detect crccheck+explode -i "$f" -f null - && echo ok; done
echo "== cron clean-up of abandoned uploads"
curl -s "$SERVER/cdn-cgi/local/scheduled" >/dev/null && echo "  scheduled handler ran"
echo "== memo page in headless Chrome"
node test/page-check.mjs test-output/memo-page.png
echo "ALL SERVER TESTS PASSED"
