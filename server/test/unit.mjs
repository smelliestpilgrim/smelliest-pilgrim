// In-process tests for the Smelliest Pilgrim Worker: helpers in isolation and
// every route, against a real SQLite schema (test/d1shim.mjs, Node built-in
// node:sqlite; no Cloudflare account, no network, no new dependency).
// usage: node test/unit.mjs [path/to/index.js]     (default ../src/index.js)
// Each test is tagged with the FIXES.md item it proves, e.g. [#3].
import assert from 'node:assert/strict'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeDB } from './d1shim.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(process.argv[2] || path.join(HERE, '../src/index.js'))
const mod = await import(pathToFileURL(SRC).href)
const W = mod.default
const TOKEN = 'unit-test-token-0123456789abcdef'
let pass = 0, fail = 0
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null
async function test(name, fn) {
  if (only && !only.test(name)) return
  try { await fn(); pass++; console.log('  ok  ', name) } catch (e) { fail++; console.log('  FAIL', name, '--', String(e && e.message || e).split('\n')[0]) }
}
function env(extra = {}) { return Object.assign({ TOKEN, TIMEZONE: 'Europe/Madrid', DB: makeDB(path.join(HERE, '../migrations')) }, extra) }
const H = (t = TOKEN) => ({ Authorization: 'Bearer ' + t })
async function req(e, method, p, { body, headers, token } = {}) {
  const r = await W.fetch(new Request('https://x.test' + p, { method, body, headers: Object.assign({}, token === null ? {} : H(token || TOKEN), headers || {}) }), e, {})
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch (_) {}
  return { status: r.status, json, text, headers: r.headers }
}
const b64 = (b) => Buffer.from(b).toString('base64')
async function sendMemo(e, id, bytes, { tz = 60, t, chunk = 16384 } = {}) {
  for (let o = 0; o < bytes.length; o += chunk) {
    const r = await req(e, 'POST', `/chunk?id=${id}&i=${o / chunk}&n=${Math.ceil(bytes.length / chunk)}&o=${o}`, { body: b64(bytes.subarray(o, o + chunk)) })
    assert.equal(r.status, 200, 'chunk ' + r.text)
  }
  const f = new URLSearchParams({ id: String(id), size: String(bytes.length), crc: String(zlib.crc32(bytes)), mode: 'o', t: String(t || id), fix: '0' })
  if (tz != null) f.set('tz', String(tz))
  return req(e, 'POST', '/commit', { body: f.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
}
const bytes = (n, seed = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff; return b }

console.log('== server unit tests: ' + path.relative(process.cwd(), SRC))

// ---------- helpers in isolation (P7)
await test('[P7] crc32: standard check value and empty input', () => {
  assert.equal(mod.crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(mod.crc32(new Uint8Array(0)), 0)
  const b = bytes(50000); assert.equal(mod.crc32(b), zlib.crc32(b))
})
await test('[P7] b64decode: valid, trimmed, rejects bad characters and bad length', () => {
  assert.deepEqual([...mod.b64decode(' AAEC \n')], [0, 1, 2])
  assert.throws(() => mod.b64decode('AA*C'))
  assert.throws(() => mod.b64decode('AAAAA'))
  assert.equal(mod.b64decode('').length, 0)
})
await test('[P7] localParts: watch offset wins, else TIMEZONE, out-of-range offset ignored, no zone = UTC', () => {
  const t = Date.UTC(2026, 10, 25, 23, 30, 5)
  assert.deepEqual(mod.localParts(t, 60, 'UTC'), { y: 2026, mo: 11, d: 26, h: 0, mi: 30, s: 5 })
  assert.deepEqual(mod.localParts(t, NaN, 'Europe/Madrid'), { y: 2026, mo: 11, d: 26, h: 0, mi: 30, s: 5 })
  assert.deepEqual(mod.localParts(t, 99999, 'Europe/London'), { y: 2026, mo: 11, d: 25, h: 23, mi: 30, s: 5 })
  assert.deepEqual(mod.localParts(t, NaN, undefined), { y: 2026, mo: 11, d: 25, h: 23, mi: 30, s: 5 })
})
await test('[P7] assemble: contiguous path, gap, overrun, bad size, stale parts ignored', () => {
  const r = (pos, len) => ({ pos, len, data: bytes(len, pos) })
  const a = mod.assemble([r(0, 4), r(4, 3), r(2, 9)], 7)
  assert.equal(a.raw.length, 7); assert.deepEqual(a.path.map((x) => x.pos), [0, 4])
  assert.match(mod.assemble([r(0, 4)], 7).problem, /missing bytes from offset 4/)
  assert.match(mod.assemble([r(0, 8)], 7).problem, /runs past the end/)
  assert.match(mod.assemble([], 32 * 1024 * 1024 + 1).problem, /bad size/)
  assert.match(mod.assemble([], -1).problem, /bad size/)
})
const areq = (h) => new Request('https://x.test/ping', { headers: h == null ? {} : { Authorization: h } })
await test('[P7] authorised: right token, wrong token, prefix, longer, no Bearer, empty server token', () => {
  const e = { TOKEN }
  assert.equal(mod.authorised(areq('Bearer ' + TOKEN), e), true)
  assert.equal(mod.authorised(areq('Bearer ' + TOKEN.replace(/.$/, 'X')), e), false)
  assert.equal(mod.authorised(areq('Bearer ' + TOKEN.slice(0, 10)), e), false)
  assert.equal(mod.authorised(areq('Bearer ' + TOKEN + 'extra'), e), false)
  assert.equal(mod.authorised(areq(TOKEN), e), false)
  assert.equal(mod.authorised(areq(null), e), false)
  // (an empty server TOKEN never reaches authorised(): fetch() answers 503 first, tested below)
})
await test('[#2] authorised: same work for a wrong token of ANY length (no early return on length)', () => {
  const e = { TOKEN }
  const orig = String.prototype.charCodeAt
  // a bare request stub, so only authorised()'s own string work is counted
  const stub = (h) => ({ headers: { get: () => h } })
  const count = (h) => { let n = 0; String.prototype.charCodeAt = function (i) { n++; return orig.call(this, i) }; try { mod.authorised(stub(h), e) } finally { String.prototype.charCodeAt = orig } return n }
  const same = count('Bearer ' + 'x'.repeat(TOKEN.length)), shorter = count('Bearer x'), longer = count('Bearer ' + 'x'.repeat(TOKEN.length * 3)), none = count(null)
  assert.ok(same > 0, 'loop ran')
  assert.deepEqual([shorter, longer, none], [same, same, same], `charCodeAt calls: same-length ${same}, shorter ${shorter}, longer ${longer}, no header ${none}`)
})

// ---------- routes
await test('[P7] 503 when TOKEN is unset or shorter than 16 characters', async () => {
  for (const T of [undefined, '', '123456789012345']) {
    const r = await req(env({ TOKEN: T }), 'GET', '/ping', { token: 'whatever-whatever' })
    assert.equal(r.status, 503); assert.match(r.json.error, /server token not set/)
  }
})
await test('[P7] 401 for a wrong or missing token (body unchanged: "bad token")', async () => {
  const e = env()
  for (const o of [{ token: 'nope' }, { token: null }, { token: TOKEN + 'x' }]) { const r = await req(e, 'GET', '/ping', o); assert.equal(r.status, 401); assert.deepEqual(r.json, { ok: false, error: 'bad token' }) }
})
await test('[P7] unknown route and wrong method: 404 "no route"', async () => {
  const e = env()
  for (const [m, p] of [['GET', '/nope'], ['GET', '/chunk'], ['PUT', '/api/days'], ['POST', '/ping'], ['GET', '/api/nope'], ['POST', '/api/memo/123']]) {
    const r = await req(e, m, p, m === 'GET' ? {} : { body: '' }); assert.equal(r.status, 404, m + ' ' + p); assert.match(r.json.error, /^no route /)
  }
})
await test('[P7] full offset-mode send, ping count, raw download byte-identical with CRC header', async () => {
  const e = env(), b = bytes(40000), id = Date.UTC(2026, 10, 25, 10, 0, 0)
  const c = await sendMemo(e, id, b)
  assert.equal(c.status, 200); assert.equal(c.json.crc, zlib.crc32(b)); assert.equal(c.json.file, '1100-00.ogg'); assert.equal(c.json.dup, false)
  const again = await sendMemo(e, id, b); assert.equal(again.json.dup, true, 'resend after a lost reply is a dup, not a second copy')
  const raw = await W.fetch(new Request(`https://x.test/api/memo/${id}/raw`, { headers: H() }), e)
  assert.equal(raw.status, 200); assert.ok(Buffer.from(await raw.arrayBuffer()).equals(b)); assert.equal(raw.headers.get('X-Memo-Crc'), String(zlib.crc32(b)))
})
await test('[#3] DELETE /api/memo/<id>: 404 for a memo that does not exist, nothing deleted', async () => {
  const e = env(), b = bytes(1000), id = 1764064800000
  await sendMemo(e, id, b)
  // an in-progress (uncommitted) memo's chunks must survive a stray DELETE
  await req(e, 'POST', '/chunk?id=1764064900000&i=0&n=1&o=0', { body: b64(bytes(10)) })
  const r = await req(e, 'DELETE', '/api/memo/1764064900000')
  assert.equal(r.status, 404); assert.deepEqual(r.json, { ok: false, error: 'no such memo' })
  assert.equal(e.DB.raw.prepare("SELECT count(*) n FROM chunks WHERE memo_id='1764064900000'").get().n, 1)
  assert.equal(e.DB.raw.prepare('SELECT count(*) n FROM memos').get().n, 1)
})
await test('[#3] DELETE /api/memo/<id>: existing memo -> unchanged {"ok":true,"deleted":"<id>"}, memo and chunks gone', async () => {
  const e = env(), id = 1764064800000
  await sendMemo(e, id, bytes(1000))
  const r = await req(e, 'DELETE', '/api/memo/' + id)
  assert.equal(r.status, 200); assert.equal(r.text, JSON.stringify({ ok: true, deleted: String(id) }))
  assert.equal(e.DB.raw.prepare('SELECT count(*) n FROM memos').get().n, 0)
  assert.equal(e.DB.raw.prepare('SELECT count(*) n FROM chunks').get().n, 0)
  assert.equal((await req(e, 'DELETE', '/api/memo/' + id)).status, 404, 'second delete is a 404')
})
await test('[#4] GET /api/logs: missing, empty or malformed day -> 400 "bad day" (same as /api/memos)', async () => {
  const e = env()
  for (const q of ['', '?day=', '?day=2026-1-25', '?day=yesterday', "?day=2026-11-25'--", '?day=2026-11-255']) {
    const r = await req(e, 'GET', '/api/logs' + q); assert.equal(r.status, 400, q); assert.deepEqual(r.json, { ok: false, error: 'bad day' })
    const m = await req(e, 'GET', '/api/memos' + q); assert.equal(m.status, 400, 'memos ' + q)
  }
})
await test('[#4][P7] /api/logs?day= lists uploaded logs; /api/log/<name> returns the text; 404 for a missing log', async () => {
  const e = env()
  const txt = Buffer.from('line one\nline two\n'), half = Math.ceil(txt.length / 2)
  const r1 = await req(e, 'POST', '/logpart?id=1764064800123&i=0&n=2', { body: b64(txt.subarray(0, half)) }); assert.equal(r1.json.done, false)
  const r2 = await req(e, 'POST', '/logpart?id=1764064800123&i=1&n=2', { body: b64(txt.subarray(half)) }); assert.equal(r2.json.done, true)
  const day = e.DB.raw.prepare('SELECT day FROM logs').get().day
  const l = await req(e, 'GET', '/api/logs?day=' + day); assert.equal(l.status, 200); assert.equal(l.json.logs.length, 1); assert.equal(l.json.logs[0].bytes, txt.length)
  const g = await req(e, 'GET', '/api/log/' + l.json.logs[0].name); assert.equal(g.status, 200); assert.equal(g.text, txt.toString())
  assert.equal((await req(e, 'GET', '/api/log/' + day + '/watch-log-000000.txt')).status, 404)
  assert.equal((await req(e, 'GET', '/api/logs?day=1999-01-01')).json.logs.length, 0)
})
await test('[P7] TIMEZONE fallback: no watch offset -> server TIMEZONE; no TIMEZONE -> UTC', async () => {
  const t = Date.UTC(2026, 10, 25, 23, 30, 5)
  const e1 = env(); const c1 = await sendMemo(e1, t, bytes(100), { tz: null })
  assert.equal(c1.json.file, '0030-05.ogg'); assert.equal(e1.DB.raw.prepare('SELECT day FROM memos').get().day, '2026-11-26')
  const e2 = env({ TIMEZONE: undefined }); const c2 = await sendMemo(e2, t, bytes(100), { tz: null })
  assert.equal(c2.json.file, '2330-05.ogg'); assert.equal(e2.DB.raw.prepare('SELECT day FROM memos').get().day, '2026-11-25')
})
await test('[P7] multi-day: memos on three days, /api/days counts each, /api/memos filters by day, same HHMM-SS gets -2', async () => {
  const e = env()
  const d = (day, h) => Date.UTC(2026, 10, day, h, 0, 0) - 3600000
  await sendMemo(e, d(23, 9), bytes(100, 1)); await sendMemo(e, d(24, 9), bytes(100, 2)); await sendMemo(e, d(24, 10), bytes(100, 3)); await sendMemo(e, d(25, 9), bytes(100, 4))
  const c = await sendMemo(e, d(25, 9) + 1, bytes(100, 5), { t: d(25, 9) }); assert.equal(c.json.file, '0900-00-2.ogg')
  const days = (await req(e, 'GET', '/api/days')).json.days
  assert.deepEqual(days.map((x) => [x.day, x.n]), [['2026-11-25', 2], ['2026-11-24', 2], ['2026-11-23', 1]])
  const m = (await req(e, 'GET', '/api/memos?day=2026-11-24')).json.memos; assert.deepEqual(m.map((x) => x.file), ['0900-00.ogg', '1000-00.ogg'])
})
await test('[P7] oversized memo (32 MiB): offset at the limit refused, commit size over the limit refused', async () => {
  const e = env(), MAX = 32 * 1024 * 1024
  const r = await req(e, 'POST', `/chunk?id=1764064800000&i=0&n=1&o=${MAX}`, { body: b64(bytes(10)) }); assert.equal(r.status, 400); assert.match(r.json.error, /bad chunk offset/)
  const ok1 = await req(e, 'POST', `/chunk?id=1764064800000&i=0&n=1&o=${MAX - 10}`, { body: b64(bytes(10)) }); assert.equal(ok1.status, 200)
  const c = await req(e, 'POST', '/commit', { body: `id=1764064800000&size=${MAX + 1}&crc=1&mode=o` }); assert.equal(c.status, 409); assert.match(c.json.error, /bad size/)
})
await test('[P7] D1 limits: one row per chunk, 48 KiB max chunk (well under D1 2 MB row limit), 96 KiB body cap', async () => {
  const e = env()
  assert.equal((await req(e, 'POST', '/chunk?id=1&i=0&n=1&o=0', { body: b64(bytes(48 * 1024)) })).status, 200)
  const big = await req(e, 'POST', '/chunk?id=1&i=0&n=1&o=0', { body: b64(bytes(48 * 1024 + 1)) }); assert.equal(big.status, 413)
  const huge = await req(e, 'POST', '/chunk?id=1&i=0&n=1&o=0', { body: 'A'.repeat(96 * 1024 + 4) }); assert.equal(huge.status, 413)
  assert.equal(e.DB.raw.prepare('SELECT max(length(data)) m FROM chunks').get().m, 48 * 1024)
})

// ---------- cron (#27): what it deletes and what it keeps
function seedOld(e, now) {
  const DAY = 24 * 3600 * 1000, db = e.DB.raw
  const memo = (id, created) => db.prepare("INSERT INTO memos (id, day, time, file, t, tz, size, crc, mode, meta, created) VALUES (?, '2026-11-01', '10:00:00', ?, ?, 60, 3, 0, 'o', '{}', ?)").run(id, id + '.ogg', 1, created)
  const chunk = (id, at) => db.prepare("INSERT INTO chunks (memo_id, kind, pos, n, len, data, at) VALUES (?, 'o', 0, -1, 3, x'010203', ?)").run(id, at)
  memo('100', now - 30 * DAY); chunk('100', now - 30 * DAY)        // committed, a month old
  memo('101', now - 2 * 3600000); chunk('101', now - 2 * 3600000) // committed, 2 h old
  chunk('200', now - 8 * DAY)                                      // abandoned upload, 8 days
  chunk('201', now - 6 * DAY)                                      // unfinished upload, 6 days (watch may still resume)
  db.prepare("INSERT INTO logparts (id, i, n, data, at) VALUES ('300', 0, 2, x'00', ?), ('301', 0, 2, x'00', ?)").run(now - 8 * DAY, now - 3600000)
  db.prepare("INSERT INTO logs (name, day, data, created) VALUES ('2026-11-01/watch-log-100000.txt', '2026-11-01', x'00', ?), ('2026-11-27/watch-log-100000.txt', '2026-11-27', x'00', ?)").run(now - 30 * DAY, now - 3600000)
}
const ids = (e, sql) => e.DB.raw.prepare(sql).all().map((r) => Object.values(r)[0]).sort()
await test('[#27] production cron: deletes only abandoned chunks/log parts older than 7 days; keeps every committed memo, its chunks and every log', async () => {
  const e = env(); seedOld(e, Date.now()); await W.scheduled({}, e, {})
  assert.deepEqual(ids(e, 'SELECT id FROM memos'), ['100', '101'])
  assert.deepEqual(ids(e, 'SELECT memo_id FROM chunks'), ['100', '101', '201'])
  assert.deepEqual(ids(e, 'SELECT id FROM logparts'), ['301'])
  assert.equal(ids(e, 'SELECT name FROM logs').length, 2)
})
await test('[#27] demo cron (DEMO=true): also wipes memos, their chunks and logs older than 24 h; keeps the last 24 h', async () => {
  const e = env({ DEMO: 'true' }); seedOld(e, Date.now()); await W.scheduled({}, e, {})
  assert.deepEqual(ids(e, 'SELECT id FROM memos'), ['101'])
  assert.deepEqual(ids(e, 'SELECT memo_id FROM chunks'), ['101', '201'])
  assert.deepEqual(ids(e, 'SELECT name FROM logs'), ['2026-11-27/watch-log-100000.txt'])
})

// ---------- item 26: rate limits and CORS
// mock of the Cloudflare rate-limit binding: `limit` requests per key, then success:false
function mockRL(limit) { const n = new Map(); return { calls: n, limit: async ({ key }) => { const c = (n.get(key) || 0) + 1; n.set(key, c); return { success: c <= limit } } } }
const ipH = (ip) => ({ 'CF-Connecting-IP': ip })
await test('[#26a] wrong token: 401 for the first 10 per IP per minute, then 429; another IP is not affected', async () => {
  const e = env({ BAD_TOKEN_RL: mockRL(10), RL: mockRL(600) })
  for (let i = 0; i < 10; i++) assert.equal((await req(e, 'GET', '/ping', { token: 'wrong-wrong-wrong-wrong', headers: ipH('203.0.113.9') })).status, 401)
  const r = await req(e, 'GET', '/ping', { token: 'wrong-wrong-wrong-wrong', headers: ipH('203.0.113.9') })
  assert.equal(r.status, 429); assert.match(r.json.error, /too many bad tokens/)
  assert.equal((await req(e, 'GET', '/ping', { token: 'wrong-wrong-wrong-wrong', headers: ipH('198.51.100.1') })).status, 401)
  assert.equal(e.RL.calls.size, 0, 'wrong tokens never count against the right-token limit')
})
await test('[#26a] right token is never blocked by wrong-token attempts from the same IP (cannot lock James out)', async () => {
  const e = env({ BAD_TOKEN_RL: mockRL(10), RL: mockRL(600) })
  for (let i = 0; i < 30; i++) await req(e, 'GET', '/ping', { token: 'wrong-wrong-wrong-wrong', headers: ipH('203.0.113.9') })
  assert.equal((await req(e, 'GET', '/ping', { headers: ipH('203.0.113.9') })).status, 200)
})
await test('[#26a] a 1.2 MB memo sent in 5 KB chunks (one request at a time, as the watch does) uses under 300 of the 600 right-token requests', async () => {
  const e = env({ BAD_TOKEN_RL: mockRL(10), RL: mockRL(600) })
  const memo = bytes(1200 * 1024, 7)
  const r = await sendMemo(e, 1764300000000, memo, { chunk: 5120 })
  assert.equal(r.status, 200, r.text); assert.equal(r.json.ok, true)
  const used = e.RL.calls.get('local')
  assert.ok(used < 300, 'requests used: ' + used)
})
await test('[#26a] right-token limit: request 601 in the window gets 429, not 401 (watch keeps the memo and stops this run)', async () => {
  const e = env({ RL: mockRL(600) })
  for (let i = 0; i < 600; i++) assert.equal((await req(e, 'GET', '/ping')).status, 200)
  const r = await req(e, 'GET', '/ping'); assert.equal(r.status, 429); assert.match(r.json.error, /too many requests/)
})
await test('[#26a] no rate-limit bindings (tests, older deploys): nothing is limited', async () => {
  const e = env()
  for (let i = 0; i < 30; i++) assert.equal((await req(e, 'GET', '/ping', { token: 'wrong-wrong-wrong-wrong' })).status, 401)
})
await test('[#26b] CORS: no Access-Control-* headers on any answer; a preflight OPTIONS gets 401, so browsers on other sites cannot call the API', async () => {
  const e = env()
  const pre = await req(e, 'OPTIONS', '/api/days', { token: null, headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
  assert.equal(pre.status, 401)
  for (const r of [pre, await req(e, 'GET', '/api/days', { headers: { Origin: 'https://evil.example' } }), await req(e, 'GET', '/ping', { token: null })]) {
    for (const [k] of r.headers) assert.ok(!/^access-control-/i.test(k), 'unexpected header ' + k)
  }
})

console.log(`UNIT: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
