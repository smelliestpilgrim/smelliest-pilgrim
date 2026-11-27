#!/usr/bin/env python3
"""Checks a BUILT Smelliest Pilgrim watch package (.zab), as Zeus 1.9.3 makes it.

Replaces check_bundle.sh, which swapped Zeus's qjsc to capture the JS and broke
when Zeus 1.9.3 moved qjsc and started shipping device code as QuickJS bytecode
(.bin). It needs no Zeus internals and changes nothing on the machine.

Fails (exit 1) if:
  * any device bytecode file (app.bin, page/*.bin) or app-side/setting JS
    references `exports` / `module.exports` / `require(` -- the 0.1.1 black-screen
    bug: a page file that exports anything is bundled as a CommonJS module and
    the watch shows a black screen. QuickJS bytecode keeps every identifier as an
    atom string, so a reference to `exports` is visible in the .bin.
  * --production is given and either app.json says packageInfo.mode != production
    (item 29: a `zeus preview` build must never be treated as a store package)
  * --appid N is given and either app.json has another appId.
usage: check-zab.py <file.zab> [--production] [--appid 1138450]
"""
import io, json, re, sys, zipfile

def inner(z):
    for n in z.namelist():
        if n.endswith('.zpk'):
            yield from inner(zipfile.ZipFile(io.BytesIO(z.read(n))))
        elif n.endswith('.zip'):
            yield from ((n[:-4] + '/' + m, b) for m, b in inner(zipfile.ZipFile(io.BytesIO(z.read(n)))))
        else:
            yield n, z.read(n)

def main(a):
    path, prod = a[0], '--production' in a
    appid = int(a[a.index('--appid') + 1]) if '--appid' in a else None
    files = dict(inner(zipfile.ZipFile(path)))
    bad, seen = [], 0
    for n, b in sorted(files.items()):
        if n.endswith('.bin') or n.endswith('.js'):
            seen += 1
            for pat in (rb'\bexports\b', rb'\brequire\s*\(' if n.endswith('.js') else rb'\brequire\b'):
                if re.search(pat, b):
                    bad.append('%s references %s' % (n, pat.decode()))
    if seen == 0:
        bad.append('no .bin/.js files found: not a Zeus package?')
    for n, b in files.items():
        if n.endswith('app.json'):
            j = json.loads(b)
            mode = (j.get('packageInfo') or {}).get('mode')
            aid = (j.get('app') or {}).get('appId')
            ver = (j.get('app') or {}).get('version', {})
            print('  %s: appId %s, version %s / code %s, mode %s' % (n, aid, ver.get('name'), ver.get('code'), mode))
            if prod and mode != 'production':
                bad.append('%s: packageInfo.mode is %r, not production (was this made by zeus preview?)' % (n, mode))
            if appid is not None and aid != appid:
                bad.append('%s: appId %s, expected %s' % (n, aid, appid))
    print('  checked %d code files in %s' % (seen, path))
    for x in bad:
        print('FAIL: ' + x)
    if not bad:
        print('BUNDLE CHECK PASSED')
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]) if len(sys.argv) > 1 else 2)
