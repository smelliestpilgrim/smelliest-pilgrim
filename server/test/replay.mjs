// Replays a day of memos through the REAL watch code (watch/utils sender.js +
// sidecore.js, the same code the Side Service runs) into the Worker running
// under `wrangler dev --local`, then checks the memo page API and the
// in-browser .ogg conversion against the original files byte for byte.
// usage: node test/replay.mjs <patched utils dir> <memo day dir> <out dir>
// The memo day dir is laid out like the phone app's (HHMM-SS.ogg, day.md, a
// watch log); test/make_day.py makes a synthetic one.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { zeppToOgg, parseZepp } from '../public/opus.js'

const [U, MEMOS, OUT] = process.argv.slice(2)
const BASE = process.env.SERVER || 'http://127.0.0.1:8787'
const TOKEN = process.env.TOKEN
const { sendAll, sendMemo, sendText } = await import(U + '/sender.js')
const { handleRequest, destination } = await import(U + '/sidecore.js')
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok', m) }

// ---- Ogg Opus -> packets (+ serial, title), then the watch's raw layout
function oggPackets(buf) {
  const pkts = []; let serial = null, cur = []
  for (let o = 0; o < buf.length;) {
    assert.equal(buf.toString('latin1', o, o + 4), 'OggS')
    serial = buf.readUInt32LE(o + 14)
    const nseg = buf[o + 26]; const lace = buf.subarray(o + 27, o + 27 + nseg)
    let p = o + 27 + nseg
    for (const l of lace) { cur.push(buf.subarray(p, p + l)); p += l; if (l < 255) { pkts.push(Buffer.concat(cur)); cur = [] } }
    o = p
  }
  const tags = pkts[1].toString('latin1'); const title = (tags.match(/TITLE=([0-9: -]+)/) || [])[1]
  return { serial, title, audio: pkts.slice(2) }
}
function toZepp(packets) {
  return Buffer.concat(packets.flatMap((p) => { const h = Buffer.alloc(8); h.writeUInt32BE(p.length, 0); crypto.randomFillSync(h, 4, 4); return [h, p] }))
}

// ---- the day's memos (times/GPS from day.md), watch offset +60 min
const dayMd = fs.readFileSync(path.join(MEMOS, 'day.md'), 'utf8')
const files = {}, memos = [], originals = {}
for (const f of fs.readdirSync(MEMOS).filter((x) => x.endsWith('.ogg')).sort()) {
  const ogg = fs.readFileSync(path.join(MEMOS, f))
  const { serial, title, audio } = oggPackets(ogg)
  // the real watch id: start second from the title, ms found from the Ogg serial (= id & 0x7fffffff)
  const sec = Date.parse(title.replace(' ', 'T') + '+01:00')
  let id = null
  for (let ms = 0; ms < 1000; ms++) if (((sec + ms) & 0x7fffffff) >>> 0 === serial) { id = sec + ms; break }
  assert.ok(id, 'id for ' + f)
  const raw = toZepp(audio)
  files[id] = raw
  originals[id] = { f, ogg, audio }
  const hhmmss = title.slice(11)
  const line = dayMd.split('\n').find((l) => l.startsWith('| ' + hhmmss + ' |')) || ''
  const g = line.match(/\| (-?\d+\.\d+), (-?\d+\.\d+) \| ([\d.]+) s/)
  const audioMs = parseZepp(new Uint8Array(raw)).durationMs
  memos.push({ id, t: id, tz: 60, bytes: raw.length, recMs: audioMs + 800, audioMs, fix: !!g, lat: g ? +g[1] : null, lon: g ? +g[2] : null,
    fixS: g ? +g[3] : null, sats: g ? 9 : -1, scrOff: 0, scrOffMs: 0, maxGapMs: 1060, keepOn: true, stopKey: 'SEL click', gpsWaitS: 12, sent: false })
}
const N = memos.length, DAY = new Date(memos[0].id + 3600000).toISOString().slice(0, 10)
const FILES = memos.map((m) => originals[m.id].f)
ok(N >= 5, N + ' memos from ' + MEMOS + ' rebuilt in the watch layout (' + memos.map((m) => m.bytes).join(', ') + ' bytes)')

// ---- Side Service shims: fetch like Zepp's, settings like the Zepp app
const zfetch = (inject) => ({ url, method, headers, body }) => {
  const r = inject && inject({ url, method, body })
  if (r) return Promise.resolve(r)
  return fetch(url, { method, headers, body }).then(async (x) => ({ status: x.status, body: await x.text() }))
}
const settings = (o) => (k) => o[k]
const SERVER = { dest: 'server', serverUrl: BASE + '/', serverToken: TOKEN }
function makeIo(cfgObj, sent, inject, chunkBytes) {
  return {
    readChunk: (m, off, len) => new Uint8Array(files[m.id].subarray(off, off + len)),
    request: (d) => new Promise((res) => handleRequest(zfetch(inject), d, (e, r) => res(r), destination(settings(cfgObj)))),
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil((ms || 0) / 100)), clearTimeout,
    markSent: (m, r) => { m.sent = true; sent.push([m.id, r]) },
    now: () => Date.now(), offsets: true, chunkBytes: chunkBytes || 10240, log: () => {}
  }
}
const call = (cfgObj, d) => new Promise((res) => handleRequest(zfetch(), d, (e, r) => res(r), destination(settings(cfgObj))))

// ---- settings -> destination
ok(destination(settings({})).base === 'http://127.0.0.1:8765' && destination(settings({})).dest === 'phone', 'no settings = WatchMemo phone app on 127.0.0.1:8765 (0.1.4 behaviour)')
ok(destination(settings({ dest: '"phone"', serverUrl: 'https://x.example' })).dest === 'phone', 'phone chosen: server URL ignored')
ok(/no server URL/.test(destination(settings({ dest: 'server' })).error), 'My server without URL: refused before sending anything')
ok(/https/.test(destination(settings({ dest: 'server', serverUrl: 'http://evil.example', serverToken: 'x' })).error), 'plain http to the internet refused')
ok(/no server token/.test(destination(settings({ dest: 'server', serverUrl: 'https://x.example' })).error), 'My server without token refused')
const d1 = destination(settings({ dest: '"server"', serverUrl: '"https://m.example.workers.dev//"', serverToken: '"abc"' }))
ok(d1.base === 'https://m.example.workers.dev' && d1.token === 'abc', 'JSON-quoted settings values and trailing slashes handled')

// ---- ping
const ping = await call(SERVER, { method: 'ping', params: {} })
ok(ping.ok && ping.offsets === true && ping.dest === 'server' && ping.app === 'Smelliest Pilgrim' && ping.protocol === 'WatchMemo', 'ping over the Side Service reaches the server: ' + JSON.stringify(ping))
const bad = await call({ ...SERVER, serverToken: 'wrong-token-wrong-token' }, { method: 'ping', params: {} })
ok(!bad.ok && bad.status === 401 && /refused the token/.test(bad.error), 'wrong token: 401, watch shows "' + bad.error + '"')
const noUrl = await call({ dest: 'server' }, { method: 'ping', params: {} })
ok(!noUrl.ok && noUrl.status === 400 && /Settings/.test(noUrl.error), 'no URL set: the watch is told where to fix it: ' + noUrl.error)

// ---- wrong token during a send = permanent failure, nothing marked sent
{
  const sent = []
  const m = { ...memos[0], sent: false }
  const r = await new Promise((res) => sendMemo(makeIo({ ...SERVER, serverToken: 'wrong-token-wrong-token' }, sent), m, null, (e, x, perm) => res([e, x, perm])))
  ok(r[0] && /token/.test(r[0]) && r[2] === true && sent.length === 0, 'send with a wrong token stops at once (permanent): ' + r[0])
}

// ---- stale garbage at an off-path offset before the real send (must be ignored)
await call(SERVER, { method: 'chunk', params: { id: memos[1].id, i: 0, n: 1, o: 7, d: Buffer.from('stale resend junk').toString('base64') } })

// ---- send all; memo 3's 10K chunk at byte 20480 fails twice with a size-type
// error, so the watch drops to 5K mid-memo (mixed chunk sizes by byte offset)
{
  const sent = []
  let fails = 0
  const inject = ({ url }) => {
    if (url.includes('/chunk?id=' + memos[2].id) && url.includes('&o=20480') && fails < 2) { fails++; return { status: 500, body: '{"ok":false,"error":"exceeded"}' } }
  }
  const io = makeIo(SERVER, sent, inject)
  const lines = []; io.log = (l) => lines.push(l)
  const done = await new Promise((res) => sendAll(io, memos, (e) => { if (e.type === 'done') res(e) }))
  ok(done.ok === N && done.failed === 0, 'all ' + N + ' memos sent to the server via the real watch sender (' + done.kbps.toFixed(0) + ' KB/s on loopback)')
  ok(sent.every(([id, r]) => r.size === files[id].length && r.crc === zlib.crc32(files[id])), 'server echoed matching size + CRC-32 for every memo')
  ok(sent.map(([, r]) => r.file).join(',') === FILES.join(','), 'file names = the phone app\'s (Madrid time): ' + sent.map(([, r]) => r.file).join(','))
  ok(fails === 2 && lines.some((l) => /chunk size 10K -> 5K/.test(l)), 'chunk size dropped 10K -> 5K mid-memo: ' + lines.find((l) => /chunk size/.test(l)))
}

// ---- resend of a saved memo (watch lost the reply): dup, nothing changes
{
  const again = { ...memos[0], sent: false }
  const r = await new Promise((res) => sendMemo(makeIo(SERVER, []), again, null, (e, x) => res([e, x])))
  ok(!r[0] && r[1].dup === true && r[1].file === FILES[0], 'resending a saved memo is idempotent (dup=true, same file)')
}

// ---- a corrupted chunk once: commit refuses (size/crc), the watch restarts the memo and it lands intact
{
  const id = memos[4].id + 1, m = { ...memos[4], id, t: id, sent: false }
  files[id] = files[memos[4].id]
  let flipped = false
  const io = makeIo(SERVER, [])
  const real = io.request
  io.request = (d) => {
    if (!flipped && d.method === 'chunk' && d.params.o === 10240) { flipped = true; const b = Buffer.from(d.params.d, 'base64'); b[100] ^= 0xff; d = { ...d, params: { ...d.params, d: b.toString('base64') } } }
    return real(d)
  }
  const r = await new Promise((res) => sendMemo(io, m, null, (e, x) => res([e, x])))
  ok(flipped && (r[0] ? /mismatch/.test(r[0]) : r[1].crc === zlib.crc32(files[id])), 'corrupted chunk never confirmed: ' + (r[0] || 'restarted and saved intact as ' + r[1].file))
  // remove the test copy so the day list holds only the day's memos
  await fetch(BASE + '/api/memo/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } })
}

// ---- protocol edge cases (same answers as the phone app)
const r4 = await call(SERVER, { method: 'commit', params: { id: 1700000007000, size: 10, crc: 1, n: 1 } })
ok(!r4.ok && /no chunks/.test(r4.error), 'commit without chunks refused: ' + r4.error)
await call(SERVER, { method: 'chunk', params: { id: 1700000008000, i: 0, n: 3, d: 'AAAA' } })
const r5 = await call(SERVER, { method: 'commit', params: { id: 1700000008000, size: 3, crc: 1, n: 3 } })
ok(!r5.ok && /missing chunks 1,2/.test(r5.error), 'index mode: missing chunks listed: ' + r5.error)
await call(SERVER, { method: 'chunk', params: { id: 1700000009000, i: 0, n: 2, o: 0, d: 'AAAA' } })
const r6 = await call(SERVER, { method: 'commit', params: { id: 1700000009000, size: 6, crc: 1, n: 2, mode: 'o' } })
ok(!r6.ok && /missing bytes from offset 3/.test(r6.error), 'offset mode: gap reported: ' + r6.error)
const big = await call(SERVER, { method: 'chunk', params: { id: 1700000010000, i: 0, n: 1, o: 0, d: Buffer.alloc(60000).toString('base64') } })
ok(!big.ok && big.status === 413, 'oversized chunk refused with 413 (watch drops chunk size): ' + big.error)
const junk = await call(SERVER, { method: 'chunk', params: { id: 1700000011000, i: 0, n: 1, o: 0, d: '!!notbase64!!' } })
ok(!junk.ok && /bad base64/.test(junk.error), 'bad base64 refused')

// ---- the watch log upload (index-numbered parts)
{
  const text = new TextEncoder().encode(fs.readFileSync(path.join(MEMOS, fs.readdirSync(MEMOS).find((x) => x.startsWith('watch-log'))), 'utf8'))
  const r = await new Promise((res) => sendText(makeIo(SERVER, []), text, null, (e, x) => res([e, x])))
  ok(!r[0] && r[1].done && /^watch-log-\d{6}(-\d+)?\.txt$/.test(r[1].file), 'watch log uploaded in ' + Math.ceil(text.length / 2048) + ' parts: ' + r[1].file)
}

// ---- the memo page API + in-browser conversion
const H = { Authorization: 'Bearer ' + TOKEN }
const unauth = await fetch(BASE + '/api/days')
ok(unauth.status === 401, 'memo API without token: 401')
const days = await (await fetch(BASE + '/api/days', { headers: H })).json()
ok(days.days.some((d) => d.day === DAY && d.n === N), 'days list: ' + JSON.stringify(days.days))
const list = (await (await fetch(BASE + '/api/memos?day=' + DAY, { headers: H })).json()).memos
ok(list.length === N && list.every((x, k) => x.file === FILES[k] && x.meta.fix === memos[k].fix && x.meta.lat === memos[k].lat && x.meta.lon === memos[k].lon) && list.some((x) => x.meta.fix) && list.some((x) => !x.meta.fix),
  'memo list has times + GPS as in day.md (' + list.filter((x) => x.meta.fix).map((x) => x.time + ' at ' + x.meta.lat + ', ' + x.meta.lon).join('; ') + '; others no fix)')
let identical = 0
for (const m of list) {
  const r = await fetch(BASE + '/api/memo/' + m.id + '/raw', { headers: H })
  const raw = new Uint8Array(await r.arrayBuffer())
  assert.equal(zlib.crc32(raw), m.crc)
  assert.ok(Buffer.from(raw).equals(files[m.id]), 'raw bytes for ' + m.file)
  const { ogg, parsed } = zeppToOgg(raw, m.id, m.day + ' ' + m.time)
  fs.writeFileSync(path.join(OUT, m.file), ogg)
  const orig = originals[m.id]
  assert.equal(parsed.packets.length, orig.audio.length)
  if (Buffer.from(ogg).equals(orig.ogg)) identical++
}
ok(identical === N, 'all ' + N + ' raw downloads match what the watch sent, and the browser-side .ogg is byte-identical to the phone app\'s original file')
const page = await fetch(BASE + '/')
ok(page.status === 200 && (await page.text()).includes('Smelliest Pilgrim') && /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''), 'memo page served (no data in it) with CSP / no-referrer headers')

console.log('REPLAY TESTS PASSED: ' + pass + ' checks')
