"""Make a synthetic day of trail memos, laid out like the phone app's day folder:
HHMM-SS.ogg files (written by the phone app's own OggOpus code via the JVM),
day.md with times and GPS, and a watch log. The audio is generated tones, not speech.
usage: python3 make_day.py <out dir> <dir with compiled phone core + TestMain>"""
import os, struct, subprocess, sys, random, datetime
out, cls = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
DAY = '2026-11-14'
TZ = datetime.timezone(datetime.timedelta(hours=1))
# (time, seconds, gps or None, fix seconds): a made-up morning on a trail
MEMOS = [('09:12:05', 7.2, None, None), ('09:40:31', 18.4, (43.009312, -1.319522), 34.2),
         ('11:03:12', 20.1, None, None), ('13:27:48', 21.3, None, None),
         ('16:05:20', 9.6, (42.930150, -1.504870), 12.8)]

def ogg_packets(path):
    data = open(path, 'rb').read(); off = 0; pkts = []; cur = b''
    while off < len(data):
        nseg = data[off+26]; segs = data[off+27:off+27+nseg]; p = off+27+nseg
        for s in segs:
            cur += data[p:p+s]; p += s
            if s < 255: pkts.append(cur); cur = b''
        off = p
    return pkts[2:]

rows = []
for k, (t, secs, gps, fixS) in enumerate(MEMOS):
    wav, ref, raw = f'{out}/.{k}.wav', f'{out}/.{k}.ref.ogg', f'{out}/.{k}.zeppopus'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
        f'aevalsrc=0.3*sin(2*PI*({200+40*k}+60*sin(2*PI*0.7*t))*t)+0.05*(random(0)-0.5):s=16000:d={secs}',
        '-ac', '1', wav], check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '16k',
        '-frame_duration', '20', '-application', 'voip', ref], check=True)
    with open(raw, 'wb') as f:
        for p in ogg_packets(ref): f.write(struct.pack('>I', len(p)) + struct.pack('>I', random.getrandbits(32)) + p)
    start = datetime.datetime.fromisoformat(f'{DAY}T{t}').replace(tzinfo=TZ)
    wid = int(start.timestamp()) * 1000 + random.randrange(1000)
    name = t[:2] + t[3:5] + '-' + t[6:] + '.ogg'
    subprocess.run(['java', '-cp', cls, 'TestMain', 'ogg', raw, f'{out}/{name}', str(wid & 0x7fffffff), f'{DAY} {t}'], check=True)
    for x in (wav, ref, raw): os.remove(x)
    m, s = divmod(round(secs), 60)
    if gps: rows.append(f'| {t} | {gps[0]:.6f}, {gps[1]:.6f} | {fixS} s | {m}:{s:02d} | [open](https://maps.google.com/?q={gps[0]:.6f},{gps[1]:.6f}) | {name} |')
    else: rows.append(f'| {t} | no fix | no fix | {m}:{s:02d} |  | {name} |')
with open(f'{out}/day.md', 'w') as f:
    f.write(f'# Watch memos {DAY}\n\n{len(MEMOS)} memos (synthetic test data).\n\n| Time | Lat, Lon | GPS fix took | Length | Google Maps | File |\n|---|---|---|---|---|---|\n' + '\n'.join(rows) + '\n')
with open(f'{out}/watch-log-170000.txt', 'w') as f:
    for i in range(160): f.write(f'{DAY} {9 + i // 20:02d}:{(i * 3) % 60:02d}:00 synthetic watch log line {i}: rec/gps/send breadcrumbs\n')
print('synthetic day written to', out, ':', ', '.join(sorted(x for x in os.listdir(out) if x.endswith('.ogg'))))
