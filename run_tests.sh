#!/bin/bash
# Phone app + watch app tests, no devices needed: Ogg repacking, the phone app's
# server logic in the JVM, and the watch's sender + Side Service relay talking to
# it over 127.0.0.1, then the Cloudflare server tests (server/test/run.sh; needs
# 'cd server && npm ci' and Chrome, or SKIP_SERVER=1). Needs JDK 17, Node 20+, ffmpeg, python3.
set -e; cd "$(dirname "$0")"
[ -x "${JAVA_HOME:-/nonexistent}/bin/javac" ] || JAVA_HOME=$HOME/jdk17; export PATH=$JAVA_HOME/bin:$PATH
T=$(mktemp -d); trap 'kill $SRV 2>/dev/null || true; rm -rf "$T"' EXIT
echo "== static: no export statements in device page/app files (they break the page on the watch)"
if grep -n "^export" watch/page/*.js watch/app.js; then echo "FAIL: page files must not export"; exit 1; fi
echo "== synthetic recordings (real libopus packets in the watch's layout)"
python3 android/test/gen_synthetic.py "$T/data"
echo "== compile APK core + tests for the JVM"
javac -nowarn -d "$T/cls" $(find android/src/com/smilingpilgrim/watchmemo/core -name '*.java') android/test/*.java 2>&1 | grep -v -i warning || true
echo "== Ogg repack: each file must decode cleanly and give the same samples as libopus's own Ogg"
for n in m20 m60 long trunc; do
  java -cp "$T/cls" TestMain convert "$T/data/$n.zeppopus" "$T/$n.ogg"
  ffmpeg -v error -err_detect crccheck+explode -i "$T/$n.ogg" -f null -
  ref=$n; [ $n = trunc ] && ref=m20; python3 android/test/compare_pcm.py "$T/data/$ref.ref.ogg" "$T/$n.ogg"
done
echo "== phone storage: zips, atomic rebuild, migration, dedupe (JVM)"
java -cp "$T/cls" TestMain unit "$T/data" "$T/unit"
echo "== 27 Nov 2026 fixes: pending expiry, connection limit, Content-Length, OggCheck, TSV safety (JVM)"
java -cp "$T/cls" FixTests "$T/data" "$T/fix"
echo "== crash test: kill -9 the app at random moments while it rewrites the zip"
for round in 1 2 3 4 5 6 7 8; do
  java -cp "$T/cls" TestMain stress "$T/data" "$T/stress" > "$T/stress.log" 2>&1 & ST=$!
  for i in $(seq 100); do grep -q STRESSING "$T/stress.log" && break; sleep 0.1; done
  sleep "0.$((RANDOM % 9 + 1))"; kill -9 $ST; wait $ST 2>/dev/null || true
  python3 - "$T/stress" <<'PY'
import sys, zipfile, os
root = sys.argv[1]
for z in [root + '/state/zips/WatchMemos_2026-11-14.zip', root + '/docs/WatchMemos/WatchMemos_2026-11-14.zip']:
    with zipfile.ZipFile(z) as f:
        assert f.testzip() is None, z
        n = f.namelist(); assert n == ['1432-05.ogg','1433-05.ogg','1434-05.ogg','1435-05.ogg','1436-05.ogg','1437-05.ogg','day.md'], n
vis = [x for x in os.listdir(root + '/docs/WatchMemos') if not x.startswith('.')]
assert vis == ['WatchMemos_2026-11-14.zip'], vis
print('  ok after kill -9: both zips complete and valid; visible folder:', vis)
PY
done
echo "== server + watch sender end to end"
PORT=18765
mkfifo "$T/in"; (java -cp "$T/cls" TestMain serve "$T/docs" "$T/state" $PORT < "$T/in" > "$T/server.log" 2>&1) & SRV=$!
exec 3>"$T/in"
for i in $(seq 50); do grep -q LISTENING "$T/server.log" 2>/dev/null && break; sleep 0.1; done
mkdir -p "$T/u"; for f in watch/utils/*.js; do sed -E "s#from '\./([a-z]+)'#from './\1.js'#" "$f" > "$T/u/$(basename "$f")"; done
echo '{"type":"module"}' > "$T/u/package.json"
PORT=$PORT node watch/test/e2e.mjs "$T/u" "$T/data"
echo "== watch pages (real page/index.js + page/menu.js on mocked @zos APIs, virtual clock)"
PORT=$PORT node --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("./watch/test/sim/hooks.mjs",pathToFileURL("./"));' watch/test/sim/run.mjs "$T/data"
exec 3>&-
echo "== phone output (Documents/WatchMemos must hold only the day zip)"
ls -la "$T/docs/WatchMemos"; Z="$T/docs/WatchMemos/WatchMemos_2026-11-14.zip"
rm -rf "$T/z" && mkdir "$T/z" && (cd "$T/z" && unzip -q "$Z") && ls -la "$T/z"
for f in "$T/z"/*.ogg; do printf '%s ' "$(basename "$f")"; ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"; ffmpeg -v error -err_detect crccheck+explode -i "$f" -f null -; done
[ -z "$(ls -A "$T/state/raw")" ] && echo "no raw copies left in private storage (all .ogg verified)"
cat "$T/z/day.md"
mkdir -p test-output && rm -rf test-output/phone && mkdir -p test-output/phone && cp "$Z" test-output/phone/ && cp -r "$T/z" test-output/phone/unzipped && cp "$T/server.log" test-output/server.log
# a failed copy inside an && chain does not trip set -e, so check the result explicitly
[ -f "test-output/phone/$(basename "$Z")" ] && [ -f test-output/phone/unzipped/day.md ] || { echo "FAIL: phone output not saved in test-output/phone/"; exit 1; }
if [ "${SKIP_SERVER:-0}" = 1 ]; then echo "== Cloudflare server tests SKIPPED (SKIP_SERVER=1)"; else
  echo "== Cloudflare server (server/test/run.sh: unit tests, wrangler dev --local replay, memo page)"
  [ -x server/node_modules/.bin/wrangler ] || { echo "FAIL: run 'cd server && npm ci' first (or SKIP_SERVER=1 to skip the server tests)"; exit 1; }
  bash server/test/run.sh
fi
echo "ALL TESTS PASSED"
