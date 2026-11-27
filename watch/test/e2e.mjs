// End-to-end on the box: the real watch sender + Side Service relay code,
// talking to the real APK server logic running in the JVM on 127.0.0.1.
// Run via ../../run_tests.sh (it copies utils/ with .js import suffixes).
import fs from 'node:fs'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
const U = process.argv[2] // dir with patched utils
const DATA = process.argv[3]
const { base64, crc32Update, scanZeppOpus } = await import(U + '/codec.js')
const { sendAll, sendMemo, makeSizeCtx, sizeError } = await import(U + '/sender.js')
const { handleRequest } = await import(U + '/sidecore.js')

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok', m) }

// --- codec units
for (let n = 0; n < 50; n++) {
  const b = new Uint8Array(Math.floor(Math.random() * 3000)).map(() => Math.floor(Math.random() * 256))
  assert.equal(base64(b), Buffer.from(b).toString('base64'))
  assert.equal(crc32Update(crc32Update(0, b.subarray(0, 100)), b.subarray(100)), zlib.crc32(b))
}
ok(true, 'base64 and incremental CRC-32 match node Buffer/zlib on 50 random buffers')
const scan = scanZeppOpus(new Uint8Array(fs.readFileSync(DATA + '/m20.zeppopus')))
ok(scan.packets === 618 && scan.audioMs === 12360, 'watch-side scan: m20 = 618 packets, 12.36 s (' + scan.audioMs + ')')
ok(scanZeppOpus(new Uint8Array(fs.readFileSync(DATA + '/m60.zeppopus'))).audioMs === 7560, 'watch-side scan: 60 ms frames counted from TOC')

// --- io shims
const zfetch = (port) => ({ url, method, headers, body }) =>
  fetch(url.replace(':8765', ':' + port), { method, headers, body }).then(async (r) => ({ status: r.status, body: await r.text() }))
function makeIo(port, files, sentLog) {
  return {
    readChunk: (m, off, len) => new Uint8Array(files[m.id].subarray(off, off + len)),
    request: (d) => new Promise((res) => handleRequest(zfetch(port), d, (e, r) => res(r))),
    setTimeout, clearTimeout,
    markSent: (m, r) => { m.sent = true; sentLog.push([m.id, r]) },
    now: () => Date.now()
  }
}
const PORT = Number(process.env.PORT || 8765)
const base = Date.parse('2026-11-14T13:32:05Z') // 14:32:05 Madrid
const files = {}, memos = []
function addMemo(name, i, extra) {
  const id = base + i * 61000
  files[id] = fs.readFileSync(DATA + '/' + name + '.zeppopus')
  const m = Object.assign({ id, t: id, tz: 60, recMs: 12500, audioMs: 12360, bytes: files[id].length, fix: true,
    lat: 43.009247 + i / 1000, lon: -1.319592, fixS: 23.4, sats: 9, scrOff: 0, scrOffMs: 0, maxGapMs: 1010, keepOn: true,
    stopKey: 'SEL click', gpsWaitS: 0, sent: false }, extra || {})
  memos.push(m)
  return m
}
addMemo('m20', 0)
addMemo('m60', 1, { fix: false, lat: null, lon: null, fixS: null, note: 'no fix after 180 s', recMs: 7600, gpsWaitS: 180 })
addMemo('long', 2, { recMs: 75100, scrOff: 1, scrOffMs: 20000, keepOn: false })
addMemo('trunc', 3, { recMs: 30000, scrOff: 2, note: 'test: cut file' })
memos.push({ id: base + 999, bytes: 0, sent: false }) // empty recording: must be skipped

// --- ping
const ping = await new Promise((res) => handleRequest(zfetch(PORT), { method: 'ping', params: {} }, (e, r) => res(r)))
ok(ping.ok && ping.app === 'WatchMemo', 'ping reaches the phone app: ' + JSON.stringify(ping))

// --- send all
const sent = []
const events = []
const done = await new Promise((res) => sendAll(makeIo(PORT, files, sent), memos, (e) => { events.push(e.type); if (e.type === 'done') res(e) }))
console.log('  send all:', JSON.stringify({ ok: done.ok, failed: done.failed, kbps: done.kbps.toFixed(0) }))
ok(done.ok === 4 && done.failed === 0, 'all 4 real memos sent, empty recording skipped')
ok(sent.every(([id, r]) => r.crc === zlib.crc32(files[id]) && r.size === files[id].length), 'phone echoed matching size+CRC for every memo')
ok(sent[0][1].file === '1432-05.ogg', 'first memo named 1432-05.ogg (Madrid time): ' + sent[0][1].file)
ok(events.includes('progress'), 'progress events fired')

// --- resend (watch lost the first reply): no duplicate on the phone
const again = { ...memos[0], sent: false }
const r2 = await new Promise((res) => sendMemo(makeIo(PORT, files, []), again, null, (e, r) => res([e, r])))
ok(!r2[0] && r2[1].dup === true && r2[1].file === '1432-05.ogg', 'resending a saved memo is idempotent (dup=true, same file)')

// --- corrupted chunk -> must NOT be confirmed
const bad = { ...memos[0], id: base + 5000, t: base + 5000, sent: false }
files[bad.id] = files[memos[0].id]
const ioBad = makeIo(PORT, files, [])
const realRead = ioBad.readChunk
ioBad.readChunk = (m, off, len) => { const c = realRead(m, off, len); return c }
ioBad.request = (d) => {
  if (d.method === 'chunk' && d.params.i === 3) d = { ...d, params: { ...d.params, d: Buffer.from('garbage!').toString('base64') } }
  return new Promise((res) => handleRequest(zfetch(PORT), d, (e, r) => res(r)))
}
const r3 = await new Promise((res) => sendMemo(ioBad, bad, null, (e, r) => res([e, r])))
ok(r3[0] && /mismatch/.test(r3[0]), 'corrupted chunk is refused at commit: ' + r3[0])

// --- commit with no chunks
const r4 = await new Promise((res) => handleRequest(zfetch(PORT), { method: 'commit', params: { id: base + 7000, size: 10, crc: 1, n: 1 } }, (e, r) => res(r)))
ok(r4.ok === false && /no chunks/.test(r4.error), 'commit without chunks refused: ' + r4.error)

// --- missing chunk
await new Promise((res) => handleRequest(zfetch(PORT), { method: 'chunk', params: { id: base + 8000, i: 0, n: 3, d: 'AAAA' } }, (e, r) => res(r)))
const r5 = await new Promise((res) => handleRequest(zfetch(PORT), { method: 'commit', params: { id: base + 8000, size: 3, crc: 1, n: 3 } }, (e, r) => res(r)))
ok(r5.ok === false && /missing chunks 1,2/.test(r5.error), 'missing chunks listed: ' + r5.error)

// --- 0.1.3 retry machinery. Time is warped: every timer runs 100x faster
// and io.now() jumps by the full delay, so 3 minutes of backoff take ~2 s.
function warp(io, extra) {
  let skew = 0
  const lines = []
  return Object.assign(io, {
    setTimeout: (fn, ms) => setTimeout(() => { skew += ms || 0; fn() }, Math.ceil((ms || 0) / 100)),
    clearTimeout,
    now: () => Date.now() + skew,
    log: (l) => lines.push(l),
    lines
  }, extra || {})
}
const runAll = (io, list) => new Promise((res) => { const ev = []; sendAll(io, list, (e) => { ev.push(e); if (e.type === 'done') res([e, ev]) }) })

// phone app closed the whole time: keeps trying for the window, then stops, marks nothing
{
  const closedSent = []
  const io = warp(makeIo(1, files, closedSent))
  const fresh = memos.slice(0, 3).map((m) => ({ ...m, sent: false }))
  const [d2, ev] = await runAll(io, fresh)
  const retryEv = ev.filter((e) => e.type === 'retry')
  ok(d2.ok === 0 && closedSent.length === 0 && /not reachable/.test(d2.lastErr) && d2.linkDead, 'phone app closed: nothing marked sent, error says: ' + d2.lastErr)
  ok(retryEv.length >= 5 && retryEv.every((e) => e.kind === 'phone') && d2.secs >= 170, 'kept retrying ~3 min (' + Math.round(d2.secs) + ' s virtual, ' + retryEv.length + ' retries) with hint "Open Smelliest Pilgrim on phone"')
  ok(d2.failed === 1, 'stops after the first memo instead of grinding through all')
  ok(io.lines.filter((l) => l.startsWith('retry chunk 1/')).length === retryEv.length && io.lines.some((l) => /gave up after/.test(l)), 'every retry logged: ' + io.lines[0])
}

// A field log, replayed in one press: phone app not reachable at first, then
// shake timeout, ble disconnect (link down 5 s) mid-memo, a lost commit reply
{
  const flakySent = []
  const list = ['m20', 'long', 'm60'].map((nm, j) => {
    const id = base + 20000 + j * 1000
    files[id] = files[memos[[0, 2, 1][j]].id]
    return { ...memos[[0, 2, 1][j]], id, t: id, sent: false }
  })
  const io = makeIo(PORT, files, flakySent)
  const realReq = io.request
  let calls = 0, linkDownUntil = 0, lostCommit = false
  const plan = { 1: 'phone', 2: 'phone', 5: 'shake', 9: 'ble', 14: 'shake' }
  warp(io, {
    linkUp: () => io.now() >= linkDownUntil,
    request: (d) => {
      calls++
      const what = plan[calls]
      if (what === 'phone') return new Promise((res) => handleRequest(zfetch(1), d, (e, r) => res(r)))
      if (what === 'shake') return Promise.reject(Object.assign(new Error('shake timeout'), { code: 1 }))
      if (what === 'ble' || io.now() < linkDownUntil) { if (what === 'ble') linkDownUntil = io.now() + 5000; return Promise.reject(new Error('ble disconnect')) }
      if (d.method === 'commit' && !lostCommit) { lostCommit = true; realReq(d); return new Promise(() => {}) } // phone saves, reply lost
      return realReq(d)
    }
  })
  const [d3, ev] = await runAll(io, list)
  const kinds = ev.filter((e) => e.type === 'retry').map((e) => e.kind)
  ok(d3.ok === 3 && d3.failed === 0, 'flaky link: all 3 memos sent in ONE press (' + d3.retries + ' retries: ' + kinds.join(',') + ')')
  ok(kinds.includes('phone') && kinds.includes('zepp') && kinds.includes('ble') && kinds.includes('other'), 'covered: not reachable, shake timeout, ble disconnect, timeout (lost commit reply)')
  ok(flakySent.every(([id, r]) => r.crc === zlib.crc32(files[id]) && r.size === files[id].length), 'every memo confirmed by size + CRC-32')
  ok(flakySent[0][1].dup === true || flakySent.some(([, r]) => r.dup === true), 'the commit whose reply was lost came back as dup (no second copy on the phone)')
  const chunkReqs = io.lines.filter((l) => /^retry chunk/.test(l)).length
  ok(chunkReqs > 0 && !io.lines.some((l) => /restarts from chunk 1/.test(l)), 'retries resumed at the failed chunk, no memo restarted')
  ok(io.lines.some((l) => /ok on try/.test(l)), 'recovery logged: ' + io.lines.find((l) => /ok on try/.test(l)))
}

// Resume across presses: link dies for good at chunk 4, next press continues there
{
  const id = base + 30000
  files[id] = files[memos[2].id] // long
  const memo = { ...memos[2], id, t: id, sent: false }
  const store = {}
  const resumeIo = (extra) => warp(makeIo(PORT, files, []), Object.assign({ loadResume: (k) => store[k] || null, saveResume: (k, o) => { if (o) store[k] = o; else delete store[k] } }, extra))
  let n1 = 0
  const io1 = resumeIo({})
  const real1 = io1.request
  io1.request = (d) => { if (d.method === 'chunk') { n1++; if (d.params.i >= 3) return Promise.reject(new Error('ble disconnect')) } return real1(d) }
  const e1 = await new Promise((res) => sendMemo(io1, memo, null, (e, r, perm) => res([e, perm])))
  ok(e1[0] && !e1[1] && store[id] && store[id].i === 3, 'press 1: gives up at chunk 4 after the window, remembers 3 confirmed chunks')
  const io2 = resumeIo({})
  const real2 = io2.request
  const seen = []
  io2.request = (d) => { if (d.method === 'chunk') seen.push(d.params.i); return real2(d) }
  const e2 = await new Promise((res) => sendMemo(io2, memo, null, (e, r) => res([e, r])))
  ok(!e2[0] && e2[1].crc === zlib.crc32(files[id]) && seen[0] === 3 && !seen.includes(0), 'press 2: resumes at chunk 4 (sent ' + seen.length + ' chunks, not ' + Math.ceil(files[id].length / 2048) + '), CRC matches')
  ok(!store[id], 'resume note cleared after the confirmed save')
}

// Phone app restarted between presses (its partial copy is gone): commit says
// missing chunks, the watch restarts that memo from chunk 1 once and succeeds
{
  const id = base + 40000
  files[id] = files[memos[0].id]
  const memo = { ...memos[0], id, t: id, sent: false }
  const n = Math.ceil(files[id].length / 2048)
  const store = { [id]: { id, n, i: 2, crc: crc32Update(0, files[id].subarray(0, 4096)), bytes: files[id].length } }
  const io = warp(makeIo(PORT, files, []), { loadResume: (k) => store[k] || null, saveResume: (k, o) => { if (o) store[k] = o; else delete store[k] } })
  const e = await new Promise((res) => sendMemo(io, memo, null, (err, r) => res([err, r])))
  ok(!e[0] && e[1].crc === zlib.crc32(files[id]) && io.lines.some((l) => /restarts from chunk 1: .*missing chunks 0,1/.test(l)), 'stale resume after phone restart: restarted from chunk 1, saved OK')
}

// ---------------- 0.1.4: chunk sizes, byte offsets, adaptive fallback ----------------
// the watch keys on offsets:true, never on the exact version string (0.2.2 or later)
const verAtLeast = (v, w) => { const a = String(v).split('.').map(Number), b = w.split('.').map(Number); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true }
ok(ping.offsets === true && verAtLeast(ping.ver, '0.2.2') && ping.maxChunk >= 16384, 'WatchMemo ' + ping.ver + ' (0.2.2+) ping says offsets:true, maxChunk ' + ping.maxChunk)
const longId = memos[2].id
const mk = (k, src) => { const id = base + 100000 + k * 1000; files[id] = files[src.id]; return { ...src, id, t: id, sent: false } }
// every offered size, both modes, against the real phone server
let kk = 0
for (const cs of [2048, 5120, 10240, 16384]) {
  for (const offsets of [true, false]) {
    const memo = mk(++kk, memos[2])
    const seen = []
    const io = makeIo(PORT, files, [])
    const real = io.request
    io.request = (d) => { if (d.method === 'chunk') seen.push(Buffer.from(d.params.d, 'base64').length + (typeof d.params.o === 'number' ? 'o' : 'i')); return real(d) }
    const ctx = makeSizeCtx(cs, offsets)
    const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr, perm, st) => res([e, rr, st]), null, ctx))
    ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]) && seen.length === Math.ceil(files[memo.id].length / cs) && seen.every((x) => x.endsWith(offsets ? 'o' : 'i')) && r[2].cs === cs,
      (cs / 1024) + ' KB chunks, ' + (offsets ? 'offsets' : 'index') + ': ' + seen.length + ' chunks, CRC ok, ' + r[2].kbps.toFixed(0) + ' KB/s on the box')
  }
}
// JSON size of each offered chunk vs ZML's 3518-byte frames
{
  const sz = [2048, 5120, 10240, 16384].map((cs) => { const j = JSON.stringify({ jsonrpc: 'hmrpcv1', method: 'chunk', params: { id: 1763900000000, i: 9999, n: 9999, o: 99999999, d: base64(new Uint8Array(cs)) } }); return [cs, j.length, Math.ceil(j.length / 3518)] })
  ok(sz.map((x) => x[2]).join(',') === '1,2,4,7', 'ZML frames per chunk: ' + sz.map((x) => x[0] / 1024 + 'K=' + x[1] + 'B/' + x[2]).join(' '))
}
ok(sizeError('timeout after 29 s', 'other') && sizeError('link error: Exceeded maximum queue limit(5)', 'other') && sizeError('request threw: send message error', 'other') && sizeError('x', 'other', { status: 413 }) &&
  !sizeError('link error: ble disconnect', 'ble') && !sizeError('link error: shake timeout', 'zepp') && !sizeError('phone app not reachable', 'phone', null, false) && sizeError('phone app not reachable', 'phone', null, true),
  'size errors: timeouts/send errors/413 count; BLE down, shake timeout, never-seen phone app do not')

// fallback mid-memo with offsets: 16K fails twice ("send message error"), 10K carries on at the same byte, no restart
{
  const memo = mk(20, memos[2])
  const io = warp(makeIo(PORT, files, []))
  const real = io.request
  const seen = []
  let first = true
  io.request = (d) => {
    if (d.method === 'chunk') {
      const len = Buffer.from(d.params.d, 'base64').length
      seen.push([d.params.o, len])
      // the first 16K chunk gets through; then 16K is refused
      if (len > 10240 && !first) return Promise.reject(new Error('send message error'))
      if (len > 10240) first = false
    }
    return real(d)
  }
  const ctx = makeSizeCtx(16384, true)
  const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr, perm, st) => res([e, rr, st]), null, ctx))
  ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]), 'fallback 16K -> 10K mid-memo: saved, CRC matches')
  ok(ctx.drops.length === 1 && ctx.drops[0].at === 16384 && seen.filter(([o]) => o === 16384).length === 3 && seen[3][0] === 16384 && seen[3][1] === 10240 && !io.lines.some((l) => /restarts/.test(l)),
    'dropped at byte 16384 after 2 refusals, resent that byte range as 10K, no restart: ' + io.lines.find((l) => /chunk size/.test(l)))
  ok(r[2].sizes.join(',') === '16384,10240' && io.lines.some((l) => /memo \d+ sent: .* chunk 16K->10K \(offsets\)/.test(l)), 'per-memo log: ' + io.lines.find((l) => /sent: /.test(l)))
}

// 16K delivered but replies lost (phone has the 16K part): the 10K resend at the same offset replaces it
{
  const memo = mk(21, memos[2])
  const io = warp(makeIo(PORT, files, []))
  const real = io.request
  io.request = (d) => {
    if (d.method === 'chunk' && Buffer.from(d.params.d, 'base64').length > 10240 && d.params.o > 0) { real(d); return new Promise(() => {}) }
    return real(d)
  }
  const ctx = makeSizeCtx(16384, true)
  const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr) => res([e, rr]), null, ctx))
  ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]) && ctx.drops.length === 1 && /timeout/.test(ctx.drops[0].why), 'lost 16K replies (timeouts): dropped to 10K, phone overwrote its 16K part, CRC matches')
}

// older phone app (index mode): a drop restarts the memo at the smaller size
{
  const memo = mk(22, memos[2])
  const io = warp(makeIo(PORT, files, []))
  const real = io.request
  io.request = (d) => (d.method === 'chunk' && Buffer.from(d.params.d, 'base64').length > 10240 && d.params.i >= 1 ? Promise.reject(new Error('send message error')) : real(d))
  const ctx = makeSizeCtx(16384, false)
  const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr) => res([e, rr]), null, ctx))
  ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]) && io.lines.some((l) => /restarts at 10K \(phone app is older than 0.2.2/.test(l)), 'index mode (phone 0.2.1): drop restarts the memo at 10K, CRC matches')
}

// adaptive fallback across a whole run: 10K then 5K refused -> ends at 2K, every memo sent in one press
{
  const sentL = []
  const list = [0, 2, 1].map((j, q) => mk(30 + q, memos[j]))
  const io = warp(makeIo(PORT, files, sentL), { chunkBytes: 10240, offsets: true, phoneOk: true })
  const real = io.request
  io.request = (d) => (d.method === 'chunk' && Buffer.from(d.params.d, 'base64').length > 2048 ? Promise.resolve({ ok: false, status: 413, error: 'body too big' }) : real(d))
  const [dn] = await runAll(io, list)
  ok(dn.ok === 3 && dn.chunkStart === 10240 && dn.chunkEnd === 2048 && dn.drops.length === 2 && sentL.every(([id, rr]) => rr.crc === zlib.crc32(files[id])),
    'run: 10K -> 5K -> 2K on HTTP 413, all 3 memos sent and CRC-confirmed, ' + dn.drops.map((x) => x.from / 1024 + 'K->' + x.to / 1024 + 'K').join(', '))
  ok(dn.perMemo.length === 3 && dn.perMemo.every((m) => m.kbps > 0 && m.cs === 2048) && dn.memoKbps > 0, 'done event has per-memo KB/s and chunk size')
}

// non-size trouble at 16K (ble disconnect, shake timeout, phone app closed at first): size stays 16K
{
  const memo = mk(40, memos[2])
  let calls = 0, downUntil = 0
  const io = warp(makeIo(PORT, files, []))
  const real = io.request
  Object.assign(io, {
    linkUp: () => io.now() >= downUntil,
    request: (d) => {
      calls++
      if (calls === 1) return new Promise((res) => handleRequest(zfetch(1), d, (e, rr) => res(rr)))
      if (calls === 2 || calls === 3) return Promise.reject(new Error('shake timeout'))
      if (calls === 4) { downUntil = io.now() + 4000; return Promise.reject(new Error('ble disconnect')) }
      if (io.now() < downUntil) return Promise.reject(new Error('ble disconnect'))
      return real(d)
    }
  })
  const ctx = makeSizeCtx(16384, true)
  const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr) => res([e, rr]), null, ctx))
  ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]) && ctx.drops.length === 0, 'phone closed, shake timeouts, BLE drop at 16K: retried at 16K, no size drop, CRC matches')
}

// resume across presses AND sizes: press 1 at 16K dies at byte 32768, press 2 at 5K continues at that byte
{
  const memo = mk(50, memos[2])
  const store = {}
  const rio = (extra) => warp(makeIo(PORT, files, []), Object.assign({ loadResume: (k) => store[k] || null, saveResume: (k, o) => { if (o) store[k] = o; else delete store[k] } }, extra))
  const io1 = rio({})
  const real1 = io1.request
  io1.request = (d) => (d.method === 'chunk' && d.params.o >= 32768 ? Promise.reject(new Error('ble disconnect')) : real1(d))
  const e1 = await new Promise((res) => sendMemo(io1, memo, null, (e, rr, perm) => res([e, perm]), null, makeSizeCtx(16384, true)))
  ok(e1[0] && !e1[1] && store[memo.id] && store[memo.id].off === 32768 && store[memo.id].mode === 'o', 'press 1 (16K): gives up, remembers byte 32768')
  const io2 = rio({})
  const real2 = io2.request
  const seen = []
  io2.request = (d) => { if (d.method === 'chunk') seen.push([d.params.o, Buffer.from(d.params.d, 'base64').length]); return real2(d) }
  const e2 = await new Promise((res) => sendMemo(io2, memo, null, (e, rr) => res([e, rr]), null, makeSizeCtx(5120, true)))
  ok(!e2[0] && e2[1].crc === zlib.crc32(files[memo.id]) && seen[0][0] === 32768 && seen.every(([o, l]) => o >= 32768 && l <= 5120), 'press 2 (5K): resumes at byte 32768 with 5K chunks, phone joins 16K+5K parts, CRC matches')
}

// 0.3.2 item 22: the watch keeps ONE resume note (localStorage 'resume', exactly as page/menu.js
// does: loadResume only returns it for the same memo id). Prove the single slot is safe: an
// overwritten note means a clean restart from byte 0, never a corrupt memo.
{
  let slot = ''
  const single = { loadResume: (id) => { const o = slot ? JSON.parse(slot) : null; return o && o.id === id ? o : null }, saveResume: (id, o) => { slot = o ? JSON.stringify(Object.assign({ id }, o)) : '' } }
  const A = mk(70, memos[2]), B = mk(71, memos[2]), C = mk(72, memos[2])
  const dying = () => { const io = warp(makeIo(PORT, files, []), single); const real = io.request; io.request = (d) => (d.method === 'chunk' && d.params.o >= 32768 ? Promise.reject(new Error('ble disconnect')) : real(d)); return io }
  const run = (io, m, cs) => new Promise((res) => sendMemo(io, m, null, (e, rr) => res([e, rr]), null, makeSizeCtx(cs, true)))
  await run(dying(), A, 16384)
  ok(JSON.parse(slot).id === A.id && JSON.parse(slot).off === 32768, 'single slot: A gave up at byte 32768, note is A')
  await run(dying(), B, 16384)
  ok(JSON.parse(slot).id === B.id, 'single slot: B gave up too, B overwrote A\'s note')
  const ioA = warp(makeIo(PORT, files, []), single); const seenA = []; const realA = ioA.request
  ioA.request = (d) => { if (d.method === 'chunk') seenA.push(d.params.o); return realA(d) }
  const rA = await run(ioA, A, 10240)
  ok(!rA[0] && rA[1].crc === zlib.crc32(files[A.id]) && rA[1].size === files[A.id].length && seenA[0] === 0, 'single slot: A (note lost) restarts cleanly from byte 0 with another chunk size; phone CRC + size match')
  const ioB = warp(makeIo(PORT, files, []), single); const seenB = []; const realB = ioB.request
  ioB.request = (d) => { if (d.method === 'chunk') seenB.push(d.params.o); return realB(d) }
  const rB = await run(ioB, B, 5120)
  ok(!rB[0] && rB[1].crc === zlib.crc32(files[B.id]) && rB[1].size === files[B.id].length && seenB[0] === 0, 'single slot: sending A replaced B\'s note, so B also restarts cleanly from byte 0 and is saved intact')
  // stale note: says C reached byte 32768, but the phone never got (or lost) those bytes
  slot = JSON.stringify({ id: C.id, n: 4, i: 2, off: 32768, cs: 16384, mode: 'o', crc: crc32Update(0, files[C.id].subarray(0, 32768)), bytes: files[C.id].length })
  const ioC = warp(makeIo(PORT, files, []), single)
  const rC = await run(ioC, C, 16384)
  ok(!rC[0] && rC[1].crc === zlib.crc32(files[C.id]) && ioC.lines.some((l) => /restarts from chunk 1: missing bytes from offset 0/.test(l)), 'stale note (phone lost the parts): commit refused as missing, memo restarts from byte 0, saved intact')
  ok(slot === '', 'note cleared after the memo is confirmed')
}

// a 0.1.3 resume note (2K index chunks) when the phone now does offsets: start again, logged, saved OK
{
  const memo = mk(60, memos[0])
  const store = { [memo.id]: { id: memo.id, n: Math.ceil(files[memo.id].length / 2048), i: 2, crc: crc32Update(0, files[memo.id].subarray(0, 4096)), bytes: files[memo.id].length } }
  const io = warp(makeIo(PORT, files, []), { loadResume: (k) => store[k] || null, saveResume: (k, o) => { if (o) store[k] = o; else delete store[k] } })
  const r = await new Promise((res) => sendMemo(io, memo, null, (e, rr) => res([e, rr]), null, makeSizeCtx(10240, true)))
  ok(!r[0] && r[1].crc === zlib.crc32(files[memo.id]) && io.lines.some((l) => /resume note was 2K index chunks, starting again with 10K offset chunks/.test(l)), '0.1.3 resume note + 0.2.2 phone: starts the memo again, saved OK')
}

// phone: offset commit with a gap is refused as missing (watch then restarts once)
{
  const id = base + 90000
  await new Promise((res) => handleRequest(zfetch(PORT), { method: 'chunk', params: { id, i: 0, n: 2, o: 0, d: 'AAAA' } }, (e, r) => res(r)))
  const r = await new Promise((res) => handleRequest(zfetch(PORT), { method: 'commit', params: { id, size: 6, crc: 1, n: 2, mode: 'o' } }, (e, r) => res(r)))
  ok(r.ok === false && /missing bytes from offset 3/.test(r.error), 'phone 0.2.2: gap in offset chunks refused: ' + r.error)
  const big = await new Promise((res) => handleRequest(zfetch(PORT), { method: 'chunk', params: { id, i: 0, n: 1, o: 0, d: Buffer.alloc(49 * 1024).toString('base64') } }, (e, r) => res(r)))
  ok(big.ok === false && big.status === 413, 'phone 0.2.2: a chunk over 48 KB is refused with 413 (a size error the watch drops on)')
}

console.log('E2E PASS ' + pass)
