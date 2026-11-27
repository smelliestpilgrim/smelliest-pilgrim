// Drives the real page/index.js, page/menu.js and page/log.js against mocked
// @zos APIs with a virtual clock. The mocks also flag risky native usage
// (W.violations): GPS stop inside its own callback, getter polling, file
// access while the recorder owns the file, double stops, navigating or
// exiting with GPS on, onGnssChange, getLatitude with args.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { W, advance } from './mock/env.mjs'
import { KEY_SELECT, KEY_UP, KEY_DOWN, KEY_BACK, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS } from './mock/interaction.mjs'
const DATA = process.argv[2]
const PORT = Number(process.env.PORT || 0)
const REC = new Uint8Array(fs.readFileSync(DATA + '/m20.zeppopus'))
let page = null
globalThis.Page = (o) => { page = o }
let n = 0, pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok', m) }

async function launch(file = 'index', keep = {}) {
  Object.assign(W, { timers: [], log: [], buzz: [], exited: false, replaced: null, pushed: null, keyCb: null, widgets: [],
    micBroken: false, violations: [], geo: null, geoCount: 0, recCreated: 0, recStops: 0, stats: 0, opusReads: 0, creates: 0, sets: 0, recording: null }, keep)
  W.recorderBytes = REC
  await import('../../page/' + file + '.js?run=' + ++n)
  const p = page
  p.build()
  return p
}
const key = (k, e = KEY_EVENT_CLICK) => W.keyCb(k, e)
const text = () => W.widgets.filter((w) => w.type === 'TEXT').map((w) => w.p.text).join(' | ')
const metas = () => [...W.files.keys()].filter((k) => /^memos\/\d+\.json$/.test(k)).map((k) => { try { return JSON.parse(new TextDecoder().decode(W.files.get(k))) } catch (e) { return null } }).filter(Boolean)
const lastMeta = () => metas().sort((a, b) => b.id - a.id)[0]
const logText = () => new TextDecoder().decode(W.files.get('memo_log.txt') || new Uint8Array())
const clean = (tag) => ok(W.violations.length === 0, tag + ': no risky native usage' + (W.violations.length ? ' -> ' + W.violations.join('; ') : ''))
const sendBtn = () => W.widgets.find((w) => w.type === 'BUTTON' && w.p.text === 'SEND')

console.log('Scenario A: normal memo, fix while talking, stop with SELECT')
let p = await launch()
ok(/MEMO/.test(text()) && /recording in 2 s/.test(text()) && sendBtn().p.visible, 'launch: prestart screen with SEND touch button, nothing running')
ok(W.recCreated === 0 && W.geoCount === 0, 'no recorder or GPS during the 2 s prestart')
advance(2000)
ok(W.buzz[0] === 'long600' && W.log.some((l) => l.startsWith('rec start memos/')), 'after 2 s: recording starts with a 600 ms buzz')
ok(sendBtn().p.visible === false, 'SEND button hidden once recording')
ok(W.geo && W.geo.count('start') === 1 && W.geo.count('onChange') === 1, 'one Geolocation, start() once, onChange() once')
const sets0 = W.sets
advance(8000); W.geo.fixNow(43.01, -1.32); advance(1000)
ok(/GPS: found \(8 s\)/.test(text()), 'GPS found (8 s) shown within a second')
ok(W.sets - sets0 <= 2 * 9 + 2, 'widget updates <= 2 per second (' + (W.sets - sets0) + ' in 9 s), no new widgets: creates=' + W.creates)
advance(11000)
key(KEY_SELECT)
advance(0)
ok(W.buzz[1] === 'two_short' && W.recStops === 1, 'SELECT click: recorder stopped once, two short buzzes')
ok(lastMeta() && lastMeta().note === 'fix pending', 'memo .json written immediately at stop (fix pending)')
advance(700)
ok(W.stats === 1, 'exactly one size check after the fixed delay (stats=' + W.stats + ')')
ok(W.buzz[2] === 'four_quick', 'saved + fix: four quick buzzes')
ok(W.geo.count('offChange') === 1 && W.geo.count('stop') === 1, 'GPS offChange+stop exactly once')
advance(2100)
ok(W.exited, 'app closed itself after the buzz')
let m = lastMeta()
ok(m.fix && m.fixS === 8 && m.bytes === REC.length && m.recMs === 20000 && m.stopKey === 'SEL click' && m.v === '0.2.1', 'memo complete: ' + JSON.stringify({ fixS: m.fixS, recMs: m.recMs, bytes: m.bytes, stopKey: m.stopKey }))
ok(W.opusReads === 0, 'the audio file is never read on the record page')
p.onDestroy()
ok(W.geo.count('stop') === 1 && W.recStops === 1, 'onDestroy after exit does not stop anything twice')
const lt = logText()
ok(['launch v0.2.1', 'rec start', 'geo started', 'fix 43.01', 'stop pressed', 'rec stopped', 'file size', 'finish fix=true', 'geo stopped', 'cleanup', 'exit', 'destroy'].every((x) => lt.includes(x)), 'breadcrumb log has every stage')
clean('A')

console.log('Scenario A2: startup is fail-safe')
W.now += 60000
W.failCreateAt = 3 // 3rd createWidget throws (inside the normal UI)
p = await launch()
ok(W.widgets[0].p.text.startsWith('Smelliest Pilgrim 0.2.1') || /Smelliest Pilgrim 0.2.1 error/.test(text()), 'first widget is the plain "Smelliest Pilgrim 0.2.1 starting" text')
ok(/Smelliest Pilgrim 0.2.1 error/.test(text()) && /BACK to exit/.test(text()), 'a startup exception is shown on screen: ' + text().replace(/\n/g, ' / '))
ok(/FATAL build/.test(logText()), 'and logged as FATAL')
W.failCreateAt = 0
p.onDestroy()
p = await launch()
advance(2000); advance(3000)
ok(key(KEY_BACK) === false && W.recStops === 1 && W.geo.count('stop') === 1, 'BACK during recording: not swallowed, recorder+GPS stopped')
p.onDestroy()
ok(W.recStops === 1, 'no double stop after BACK')

console.log('Scenario B: no fix at stop, fix arrives 70 s later')
W.now += 60000
p = await launch()
advance(2000); advance(10000); key(KEY_DOWN); advance(1000)
ok(/WAITING FOR GPS/.test(text()) && /press UP to skip GPS/.test(text()), 'WAITING FOR GPS, hint says press UP')
advance(30000)
ok(!W.exited && /(30|31) s/.test(text()), 'shows seconds waited: ' + text())
key(KEY_SELECT); key(KEY_DOWN); advance(100)
ok(!W.exited && W.log.filter((l) => l === 'exit').length === 0, 'SELECT/DOWN clicks while waiting do nothing')
advance(38000); W.geo.fixNow(43.0, -1.3)
ok(W.geo.count('stop') === 0, 'fix callback itself stops nothing (deferred to the tick)')
advance(1000)
ok(W.buzz.at(-1) === 'four_quick', 'fix -> four quick buzzes within a second')
advance(2100)
m = lastMeta()
ok(W.exited && m.fix && m.gpsWaitS >= 69 && m.gpsWaitS <= 71, 'closed; gpsWaitS=' + m.gpsWaitS)
p.onDestroy(); clean('B')

console.log('Scenario C: never a fix -> 3 minute limit')
W.now += 60000
p = await launch()
advance(2000); advance(5000); key(KEY_SELECT); advance(1000)
advance(178000)
ok(!W.exited, 'still waiting just before 3:00')
advance(2000)
m = lastMeta()
ok(W.buzz.at(-1) === 'long1000' && !m.fix && /no fix after 180 s/.test(m.note), 'after 3:00: saved as no fix, one long buzz')
advance(2100); ok(W.exited, 'closed')
p.onDestroy(); clean('C')

console.log('Scenario D: single click in prestart -> Send page, nothing started')
W.now += 60000
p = await launch()
advance(100); key(KEY_UP)
ok(!W.replaced, 'click inside the 0.4 s launch guard ignored')
advance(500); key(KEY_DOWN); advance(200)
ok(W.replaced === 'page/menu' && W.recCreated === 0 && W.geoCount === 0, 'click at 0.6 s opens Send page; no recorder, no GPS ever started')
advance(3000)
ok(W.recCreated === 0, 'recording does not start later either')
p.onDestroy(); clean('D')

console.log('Scenario D2: tap SEND touch button in prestart')
W.now += 60000
p = await launch()
advance(800); sendBtn().p.click_func(); advance(200)
ok(W.replaced === 'page/menu' && W.recCreated === 0, 'tap SEND opens Send page without recording')
p.onDestroy(); clean('D2')

console.log('Scenario E: long presses are never handled')
W.now += 60000
p = await launch()
advance(1000)
ok(key(KEY_UP, KEY_EVENT_LONG_PRESS) === false && key(KEY_SELECT, KEY_EVENT_LONG_PRESS) === false, 'prestart: long press returned to the system')
advance(1500)
ok(key(KEY_UP, KEY_EVENT_LONG_PRESS) === false && W.recStops === 0, 'recording: long press ignored, keeps recording')
key(KEY_SELECT); advance(1000)
ok(key(KEY_UP, KEY_EVENT_LONG_PRESS) === false && !W.exited, 'GPS wait: long press ignored')
key(KEY_UP); advance(100)
m = lastMeta()
ok(/gave up waiting \(UP\)/.test(m.note) && !m.fix, 'single UP click while waiting: give up, saved as no fix')
advance(2100); ok(W.exited, 'closed')
p.onDestroy(); clean('E')

console.log('Scenario F: BACK / app killed mid-recording')
W.now += 60000
p = await launch()
advance(2000); advance(9000)
ok(key(KEY_BACK) === false, 'BACK goes to the system')
p.onDestroy()
m = lastMeta()
ok(m && /app closed during recording/.test(m.note) && m.recMs === 9000 && W.recStops === 1 && W.geo.count('stop') === 1, 'onDestroy stops recorder+GPS once and keeps the memo')
clean('F')

console.log('Scenario G: screen goes off while recording (Screen OFF setting)')
W.now += 60000
W.storage.set('keepOn', '0')
p = await launch()
advance(2000)
ok(!W.log.includes('pauseDrop 0'), 'screen not held on')
advance(5000); W.screen.set(2); advance(20000); W.screen.set(1); W.geo.fixNow(1, 2); advance(3000)
key(KEY_SELECT); advance(4000)
m = lastMeta()
ok(m.scrOff === 1 && m.scrOffMs === 20000 && m.keepOn === false, 'screen-off counted: 1x, 20000 ms')
p.onDestroy(); W.storage.delete('keepOn'); clean('G')

console.log('Scenario H: mic fails')
W.now += 60000
p = await launch('index', { micBroken: true })
advance(2500)
ok(/MIC FAILED/.test(text()), 'MIC FAILED shown')
advance(6000); ok(W.exited, 'closes'); ok(W.geoCount === 0, 'GPS never started')
p.onDestroy(); clean('H')

console.log('Scenario I: safe mode, GPS OFF')
W.now += 60000
W.storage.set('gpsOn', '0')
p = await launch()
advance(2000)
ok(W.geoCount === 0 && /GPS: off/.test(text()), 'no Geolocation created at all')
advance(6000); key(KEY_SELECT); advance(1000)
m = lastMeta()
ok(!m.fix && /GPS off/.test(m.note), 'saved without GPS wait: ' + m.note)
advance(2100); ok(W.exited, 'closed')
p.onDestroy(); W.storage.delete('gpsOn'); clean('I')


console.log('Scenario J: GPS+sats opt-in records satellites used')
W.now += 60000
W.storage.set('satsOn', '1')
p = await launch()
advance(2000)
ok(W.geo.count('onGnssChange') === 1, 'opt-in: one onGnssChange listener')
advance(3000); W.geo.gnss({ nb_used_satellite: 0, nb_valid_satellite: 4 }); W.geo.gnss(undefined); W.geo.gnss({ nb_used_satellite: 7, nb_valid_satellite: 12 })
W.geo.fixNow(42.46, -6.1); W.geo.gnss({ nb_used_satellite: 9, nb_valid_satellite: 14 }); advance(1000)
ok(/9 sats/.test(text()), 'screen shows sats with the fix: ' + text().split(' | ').find((x) => /GPS/.test(x)))
key(KEY_SELECT); advance(800)
ok(W.geo.count('offGnssChange') === 1 && W.geo.calls.indexOf('offGnssChange') < W.geo.calls.lastIndexOf('stop'), 'offGnssChange once, before stop()')
advance(2100)
m = lastMeta()
ok(m.sats === 9 && m.fix, 'memo carries sats=9')
ok(/gnss first: used=0/.test(logText()) && /sats=9/.test(logText()), 'gnss breadcrumbs logged')
p.onDestroy(); W.storage.delete('satsOn'); clean('J')
W.now += 60000
p = await launch()
advance(2000); W.geo.fixNow(1, 2); advance(1000); key(KEY_SELECT); advance(3000)
ok(W.geo.count('onGnssChange') === 0 && lastMeta().sats === undefined, 'default (GPS: ON): no onGnssChange, no sats field')
p.onDestroy(); clean('J2')

console.log('Scenario K: Send page GPS button cycles ON -> GPS+sats -> OFF')
W.request = () => new Promise(() => {})
p = await launch('menu')
const gbtn = () => W.widgets.find((w) => w.type === 'BUTTON' && /^GPS/.test(w.p.text))
ok(gbtn().p.text === 'GPS: ON', 'starts at GPS: ON')
gbtn().p.click_func(); ok(gbtn().p.text === 'GPS+sats' && W.storage.get('satsOn') === '1' && W.storage.get('gpsOn') !== '0', 'tap: GPS+sats')
gbtn().p.click_func(); ok(gbtn().p.text === 'GPS: OFF' && W.storage.get('gpsOn') === '0' && W.storage.get('satsOn') === '0', 'tap: GPS: OFF (safe mode)')
gbtn().p.click_func(); ok(gbtn().p.text === 'GPS: ON' && W.storage.get('gpsOn') === '1', 'tap: back to GPS: ON')
p.onDestroy()

console.log('Scenario K1: chunk-size button cycles with single taps (0.1.4)')
p = await launch('menu')
const cbtn = () => W.widgets.find((w) => w.type === 'BUTTON' && /^Chunk/.test(w.p.text))
ok(cbtn() && cbtn().p.text === 'Chunk 10K' && !W.storage.has('chunkB'), 'default: Chunk 10K')
const seenSizes = []
for (let k = 0; k < 4; k++) { cbtn().p.click_func(); seenSizes.push(cbtn().p.text + '=' + W.storage.get('chunkB')) }
ok(seenSizes.join(',') === 'Chunk 16K=16384,Chunk 2K=2048,Chunk 5K=5120,Chunk 10K=10240', 'taps: ' + seenSizes.join(', '))
ok(!W.widgets.some((w) => w.p && w.p.long_press_func), 'no long-press handlers on any button')
W.storage.set('chunkB', 'garbage'); p.onDestroy(); p = await launch('menu')
ok(cbtn().p.text === 'Chunk 10K', 'bad stored value falls back to 10K')
p.onDestroy(); W.storage.delete('chunkB')

// A fake phone in virtual time: chunks by index (overwrite), commit echoes size+CRC.
const zlib = await import('node:zlib')
function fakePhone(fault, opt) {
  const parts = {}, saved = {}, offs = {}
  const sizes = []
  let calls = 0
  return {
    saved, sizes, calls: () => calls,
    request(d) {
      calls++
      const f = fault(d, calls)
      if (f) return f
      const q = d.params
      if (d.method === 'ping') return Promise.resolve(opt && opt.offsets ? { ok: true, today: 0, offsets: true, ver: '0.2.2' } : { ok: true, today: 0 })
      if (d.method === 'chunk') sizes.push(Buffer.from(q.d, 'base64').length)
      if (d.method === 'chunk' && typeof q.o === 'number') { (offs[q.id] = offs[q.id] || new Map()).set(q.o, Buffer.from(q.d, 'base64')); return Promise.resolve({ ok: true, i: q.i, o: q.o }) }
      if (d.method === 'chunk' || d.method === 'logpart') { (parts[q.id] = parts[q.id] || [])[q.i] = Buffer.from(q.d, 'base64'); return Promise.resolve({ ok: true, i: q.i }) }
      if (d.method === 'commit') {
        let b
        if (offs[q.id]) { const a = []; let at = 0; while (at < q.size) { const c = offs[q.id].get(at); if (!c) break; a.push(c); at += c.length } b = Buffer.concat(a) }
        else b = Buffer.concat(parts[q.id] || [])
        saved[q.id] = (saved[q.id] || 0) + 1
        return Promise.resolve({ ok: true, size: b.length, crc: zlib.crc32(b), file: 'f' + q.id + '.ogg' })
      }
      return Promise.resolve({ ok: false, error: 'unknown' })
    }
  }
}
const tickAsync = async (ms, until) => {
  for (let t = 0; t < ms; t += 250) { advance(250); for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r)); if (until && until()) return true }
  return until ? until() : true
}
const statusText = () => text()

console.log('Scenario K2: one press of SEND rides out a Bluetooth drop (2K chunks, as 0.1.3)')
{
  W.storage.set('chunkB', '2048')
  let downAt = 0
  W.linkUp = true
  const ph = fakePhone((d, c) => {
    if (d.method === 'chunk' && c === 4 && !downAt) { downAt = W.now; W.linkUp = false; W.later = W.now + 6000 }
    if (!W.linkUp) return Promise.reject(Object.assign(new Error('ble disconnect'), { code: 2 }))
    if (d.method === 'chunk' && c === 12) return Promise.reject(Object.assign(new Error('shake timeout'), { code: 1 }))
    return null
  })
  W.request = (d) => ph.request(d)
  p = await launch('menu')
  const unsent0 = metas().filter((x) => !x.sent && x.bytes > 0).length
  key(KEY_SELECT); advance(0)
  let sawBle = false
  await tickAsync(60000, () => { if (/Watch not connected to phone/.test(statusText())) sawBle = true; if (W.later && W.now >= W.later) { W.linkUp = true; W.later = 0 } return /Log sent|Log not sent/.test(statusText()) })
  ok(sawBle, 'during the drop the screen says "Watch not connected to phone. Waiting..."')
  ok(/ALL \d+ SENT OK/.test(statusText()), 'one press: ' + statusText().split(' | ').slice(-1))
  ok(metas().filter((x) => x.sent).length >= unsent0 && Object.values(ph.saved).every((v) => v === 1), unsent0 + ' memos marked sent, each committed once')
  ok(/retry chunk \d+\/\d+ #2 in \ds: link error: ble disconnect/.test(logText()) && /link error: shake timeout/.test(logText()) && /ok on try/.test(logText()), 'retries and recovery in the breadcrumb log')
  ok(W.linkChecks > 0, 'BLE status polled while the link was down (' + W.linkChecks + ' checks)')
  ok(!/chunk size .* -> /.test(logText()), 'BLE drop and shake timeout did not change the chunk size')
  p.onDestroy()
}

// fresh unsent memos for the chunk-size scenarios
async function recordMemos(k) {
  for (const key0 of [...W.files.keys()]) if (/^memos\//.test(key0)) W.files.delete(key0)
  for (let j = 0; j < k; j++) { W.now += 60000; p = await launch('index'); advance(2000); advance(5000); key(KEY_SELECT); advance(4000); p.onDestroy() }
}

console.log('Scenario K4: default 10K chunks, phone 0.2.2 (byte offsets)')
{
  await recordMemos(2)
  W.storage.delete('chunkB')
  const ph = fakePhone(() => null, { offsets: true })
  W.request = (d) => ph.request(d)
  p = await launch('menu')
  await tickAsync(500)
  key(KEY_SELECT); advance(0)
  await tickAsync(60000, () => /Log sent|Log not sent/.test(statusText()))
  ok(/ALL 2 SENT OK\. [\d.]+ KB\/s @10K, /.test(statusText()), 'screen: ' + statusText().split(' | ').slice(-1))
  ok(ph.sizes.length > 0 && ph.sizes.every((b) => b <= 10240) && ph.sizes.some((b) => b === 10240), 'chunks went as 10 KB (' + ph.sizes.length + ' chunks: ' + ph.sizes.slice(0, 4).join(',') + '...)')
  ok(/memo \d+ sent: [\d.]+ KB in [\d.]+ s = [\d.]+ KB\/s, chunk 10K \(offsets\)/.test(logText()), 'per-memo chunk size + KB/s in the watch log')
  ok(/send done ok=2 .* chunk 10K offsets/.test(logText()), 'send done line has chunk size: ' + logText().split('\n').find((l) => /send done ok=2/.test(l)))
  ok(cbtn().p.text === 'Chunk 10K', 'chunk button back to the setting after the send')
  p.onDestroy()
}

console.log('Scenario K5: 16K keeps failing -> drops to 10K by itself, finishes in one press')
{
  await recordMemos(2)
  W.storage.set('chunkB', '16384')
  const ph = fakePhone((d) => (d.method === 'chunk' && d.params.d.length > 20000 ? Promise.reject(new Error('send message error')) : null), { offsets: true })
  W.request = (d) => ph.request(d)
  p = await launch('menu')
  await tickAsync(500)
  key(KEY_SELECT); advance(0)
  let sawNow = false
  await tickAsync(120000, () => { if (W.widgets.some((w) => w.type === 'BUTTON' && w.p.text === 'Now 10K')) sawNow = true; return /Log sent|Log not sent/.test(statusText()) })
  ok(/ALL 2 SENT OK\. [\d.]+ KB\/s @16K->10K/.test(statusText()), 'screen: ' + statusText().split(' | ').slice(-1))
  ok(/chunk size 16K -> 10K for the rest of this send, after 2 errors at byte 0: .*send message error/.test(logText()), 'drop logged: ' + logText().split('\n').find((l) => /chunk size 16K/.test(l)))
  ok((logText().match(/chunk size 16K -> 10K/g) || []).length === 1, 'dropped once, the second memo started at 10K')
  ok(Object.values(ph.saved).length === 2 && Object.values(ph.saved).every((v) => v === 1) && metas().filter((x) => x.sent).length === 2, 'both memos committed once and marked sent')
  ok(W.storage.get('chunkB') === '16384', 'setting itself unchanged (the drop is for that send only)')
  p.onDestroy(); W.storage.delete('chunkB')
}

console.log('Scenario K3: WatchMemo never opened: clear message, keeps trying ~3 min, marks nothing (10K: size never drops)')
{
  for (const k of [...W.files.keys()]) if (/^memos\//.test(k)) W.files.delete(k)
  p = await launch('index'); advance(2000); advance(5000); key(KEY_SELECT); advance(4000); p.onDestroy()
  const ph = fakePhone(() => Promise.resolve({ ok: false, error: 'phone app not reachable (network error)' }))
  W.request = (d) => ph.request(d)
  p = await launch('menu')
  key(KEY_SELECT); advance(0)
  await tickAsync(3000)
  ok(/Open Smelliest Pilgrim on phone/.test(statusText()) && /retrying in \d+ s/.test(statusText()), 'screen: "Open Smelliest Pilgrim on phone" + retry countdown: ' + statusText().split(' | ').slice(-3).join(' / '))
  await tickAsync(120000)
  ok(!/left\./.test(statusText()), 'still trying after 2 min')
  await tickAsync(120000, () => /left\./.test(statusText()))
  ok(/0 sent, 1 left\. Open Smelliest Pilgrim on phone, then SEND\./.test(statusText()) && W.widgets.some((w) => w.type === 'BUTTON' && w.p.text === 'SEND ALL'), 'gives up after the window with a clear next step; SEND ready again')
  ok(metas().every((x) => !x.sent) && W.storage.get('resume') === '', 'nothing marked sent (no chunk confirmed, nothing to resume)')
  const n0 = ph.calls()
  key(KEY_SELECT); advance(0); await tickAsync(5000)
  p.onDestroy()
  const n1 = ph.calls()
  await tickAsync(60000)
  ok(ph.calls() === n1 && n1 > n0, 'leaving the page mid-retry stops all retries (no requests after onDestroy)')
  ok(!/chunk size 10K -> /.test(logText()), 'phone app closed is not a size problem: no drop')
}

console.log('Scenario L: corrupt / orphan memo files from a crash')
W.files.set('memos/1763000000000.json', new TextEncoder().encode('{"id":1763000000000,"t":17630'))
W.files.set('memos/1763000000000.opus', REC)
W.files.set('memos/1763000000001.opus', new Uint8Array(0))
W.files.set('memos/junk.json', new TextEncoder().encode('nonsense'))
W.request = () => new Promise(() => {})
p = await launch('menu')
ok(/to send/.test(text()), 'Send page lists memos despite a half-written .json: ' + text().split(' | ')[0])
p.onDestroy()

console.log('Scenario M: log page')
p = await launch('log')
ok(/newest first/.test(text()) && /(exit|send page open|retry)/.test(text()), 'log page shows breadcrumbs')
p.onDestroy()

if (PORT) {
  console.log('Scenario N: Send page + log against the real phone-app server (JVM)')
  const { handleRequest } = await import('../../utils/sidecore.js')
  const zf = ({ url, method, headers, body }) => fetch(url.replace(':8765', ':' + PORT), { method, headers, body }).then(async (r) => ({ status: r.status, body: await r.text() }))
  W.request = (d) => new Promise((res) => handleRequest(zf, d, (e, r) => res(r)))
  p = await launch('menu')
  await new Promise((r) => setTimeout(r, 300))
  ok(/phone app ready/.test(text()), 'ping: phone app ready')
  key(KEY_SELECT); advance(0)
  for (let i = 0; i < 100 && !/Log sent|Log not sent/.test(text()); i++) await new Promise((r) => setTimeout(r, 100))
  ok(/ALL \d+ SENT OK.*Log sent/.test(text()), 'Send all, then log sent: ' + text().split(' | ').slice(-1))
  const confirmed = metas().filter((x) => x.sent)
  ok(confirmed.length >= 2 && confirmed.every((x) => x.sentSize > 0), confirmed.length + ' memos marked sent with confirmed size')
  const btn = W.widgets.find((w) => w.type === 'BUTTON' && /^Clear/.test(w.p.text))
  btn.p.click_func(); const before = W.files.size; btn.p.click_func()
  ok(W.files.size < before && metas().every((x) => !x.sent), 'Clear (two taps) removed only confirmed memos')
  p.onDestroy()
  p = await launch('log')
  W.widgets.find((w) => w.type === 'BUTTON').p.click_func()
  for (let i = 0; i < 50 && W.widgets[0].p.text === 'SENDING'; i++) await new Promise((r) => setTimeout(r, 100))
  ok(W.widgets[0].p.text === 'LOG SENT', 'log page SEND LOG works')
  p.onDestroy()
}
console.log('SIM PASS ' + pass)
