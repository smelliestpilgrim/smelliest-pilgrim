import subprocess, sys
import numpy as np
def pcm(p): return np.frombuffer(subprocess.run(['ffmpeg','-v','error','-i',p,'-f','s16le','-ar','48000','-'],capture_output=True,check=True).stdout,np.int16)
a, b = pcm(sys.argv[1]), pcm(sys.argv[2])
m = min(len(a), len(b))
d = int(np.abs(a[:m].astype(int) - b[:m].astype(int)).max())
print(f'  {sys.argv[2].split("/")[-1]}: {len(b)/48000:.2f} s, identical to libopus decode over {m/48000:.2f} s' if d == 0 else f'  DIFF {d}')
sys.exit(0 if d == 0 else 1)
