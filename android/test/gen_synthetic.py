"""Make synthetic watch recordings: real Opus packets (libopus via ffmpeg, 16 kHz mono)
written in the watch's opus_demo layout (4-byte BE length + 4-byte range + packet)."""
import os, struct, subprocess, sys, random
out = sys.argv[1]; os.makedirs(out, exist_ok=True)

def ogg_packets(path):
    data = open(path, 'rb').read(); off = 0; pkts = []; cur = b''
    while off < len(data):
        assert data[off:off+4] == b'OggS'
        nseg = data[off+26]; segs = data[off+27:off+27+nseg]; p = off+27+nseg
        for s in segs:
            cur += data[p:p+s]; p += s
            if s < 255: pkts.append(cur); cur = b''
        off = p
    return pkts[2:]  # drop OpusHead, OpusTags

def make(name, secs, frame_ms, bitrate):
    wav = f'{out}/{name}.src.wav'; ogg = f'{out}/{name}.ref.ogg'
    # speech-ish: two wobbling tones + noise
    subprocess.run(['ffmpeg','-y','-loglevel','error','-f','lavfi','-i',
        f'aevalsrc=0.3*sin(2*PI*(220+60*sin(2*PI*0.7*t))*t)+0.2*sin(2*PI*(660+90*sin(2*PI*1.3*t))*t)+0.05*(random(0)-0.5):s=16000:d={secs}',
        '-ac','1','-ar','16000',wav], check=True)
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',wav,'-c:a','libopus','-b:a',bitrate,
        '-frame_duration',str(frame_ms),'-application','voip',ogg], check=True)
    pkts = ogg_packets(ogg)
    with open(f'{out}/{name}.zeppopus','wb') as f:
        for p in pkts:
            f.write(struct.pack('>I', len(p)) + struct.pack('>I', random.getrandbits(32)) + p)
    print(name, len(pkts), 'packets', os.path.getsize(f'{out}/{name}.zeppopus'), 'bytes')

make('m20', 12.34, 20, '16k')
make('m60', 7.5, 60, '24k')
make('long', 75, 20, '20k')
# truncated: cut mid-packet
d = open(f'{out}/m20.zeppopus','rb').read()
open(f'{out}/trunc.zeppopus','wb').write(d[:len(d)-17])
