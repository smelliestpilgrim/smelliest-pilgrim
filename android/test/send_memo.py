"""Send one recording to a WatchMemo server exactly like the watch does (chunks + commit).
usage: send_memo.py PORT FILE T_MS [lat lon]   (no lat/lon = no fix)
       send_memo.py PORT --log TEXT"""
import sys, base64, zlib, urllib.request, urllib.parse, json
port = sys.argv[1]; base = f'http://127.0.0.1:{port}'
def post(path, body, ctype='text/plain'):
    r = urllib.request.Request(base + path, data=body, method='POST', headers={'Content-Type': ctype})
    with urllib.request.urlopen(r, timeout=30) as f: return json.loads(f.read())
if sys.argv[2] == '--log':
    b = sys.argv[3].encode(); print(post('/logpart?id=9&i=0&n=1', base64.b64encode(b))); sys.exit()
raw = open(sys.argv[2], 'rb').read(); t = sys.argv[3]; n = (len(raw) + 2047) // 2048
for i in range(n): post(f'/chunk?id={t}&i={i}&n={n}', base64.b64encode(raw[i*2048:(i+1)*2048]))
fix = len(sys.argv) > 5
form = dict(id=t, t=t, size=len(raw), crc=zlib.crc32(raw), tz=60, fix=1 if fix else 0, lat=sys.argv[4] if fix else '', lon=sys.argv[5] if fix else '',
            sats=8 if fix else -1, fixS=37 if fix else -1, recMs=13000, keepOn=1, stopKey='SELECT', gpsWaitS=20)
print(post('/commit', urllib.parse.urlencode(form).encode(), 'application/x-www-form-urlencoded'))
