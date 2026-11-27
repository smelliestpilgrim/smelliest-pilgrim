// Smelliest Pilgrim server: the same little HTTP protocol as the phone app (protocol name "WatchMemo")
// (phone/src/.../core/MemoService.java), on a Cloudflare Worker with D1.
//
//   GET  /ping                          -> {"ok":true,"today":N,"offsets":true,...}
//   POST /chunk?id=&i=&n=&o=  body=b64  -> {"ok":true,"i":i,"o":o,"len":L}   (byte offset)
//   POST /chunk?id=&i=&n=     body=b64  -> {"ok":true,"i":i}                 (index, older watches)
//   POST /logpart?id=&i=&n=   body=b64  -> {"ok":true,"i":i,"done":bool[,"file":..]}
//   POST /commit  form fields           -> {"ok":true,"size":..,"crc":..,"file":"HHMM-SS.ogg","dup":bool}
//
// Plus a private API for the memo page (public/index.html):
//   GET /api/days, GET /api/memos?day=, GET /api/memo/<id>/raw, DELETE /api/memo/<id>,
//   GET /api/logs?day=, GET /api/log/<name>
//
// Every route needs "Authorization: Bearer <TOKEN>" (TOKEN is a Worker secret).
// A memo only counts as saved when every byte arrived and size + CRC-32 match
// what the watch computed, exactly as on the phone.

const VERSION = '0.3.2-server'
const MAX_CHUNK_BYTES = 48 * 1024
const MAX_MEMO_BYTES = 32 * 1024 * 1024
const MAX_CHUNKS = 16384
const MAX_BODY = 96 * 1024
const STALE_MS = 7 * 24 * 3600 * 1000

const J = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const ok = (fields) => new Response(JSON.stringify(Object.assign({ ok: true }, fields || {})), { headers: J })
const err = (status, error) => new Response(JSON.stringify({ ok: false, error }), { status, headers: J })

// ---------- helpers

let CRC_TABLE = null
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function b64decode(s) {
  const t = s.trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) throw new Error('bad base64')
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function u8(v) {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (Array.isArray(v)) return Uint8Array.from(v)
  if (v && v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  return new Uint8Array(0)
}

function concat(parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

const int = (s) => (s != null && /^-?\d{1,16}$/.test(String(s)) ? Number(s) : -1)
const num = (s) => { const v = s == null || s === '' ? NaN : Number(s); return Number.isFinite(v) ? v : -1 }
const pad2 = (n) => (n < 10 ? '0' : '') + n

// Local date parts for t (epoch ms): the watch's offset (minutes) when given,
// otherwise the server's TIMEZONE.
export function localParts(t, tzMin, zone) {
  if (Number.isFinite(tzMin) && tzMin >= -14 * 60 && tzMin <= 14 * 60) {
    const d = new Date(t + tzMin * 60000)
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
  }
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }
}
const dayOf = (p) => p.y + '-' + pad2(p.mo) + '-' + pad2(p.d)

export function authorised(request, env) {
  const want = String(env.TOKEN || '')
  const h = request.headers.get('Authorization') || ''
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  // Same loop, same work, whatever length was sent: a length mismatch is
  // folded into diff instead of returning early (no length oracle).
  let diff = got.length ^ want.length
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) | 0) // past the end: NaN|0 = 0
  return diff === 0
}

async function bodyText(request) {
  const len = Number(request.headers.get('Content-Length') || 0)
  if (len > MAX_BODY) throw Object.assign(new Error('chunk too big: body ' + len), { status: 413 })
  const t = await request.text()
  if (t.length > MAX_BODY) throw Object.assign(new Error('chunk too big: body ' + t.length), { status: 413 })
  return t
}

// ---------- protocol routes

async function ping(env) {
  const today = dayOf(localParts(Date.now(), NaN, env.TIMEZONE))
  const r = await env.DB.prepare('SELECT count(*) AS n FROM memos WHERE day = ?').bind(today).first()
  return ok({ today: (r && r.n) || 0, app: 'Smelliest Pilgrim', protocol: 'WatchMemo', ver: VERSION, server: true, offsets: true, maxChunk: MAX_CHUNK_BYTES })
}

async function chunk(request, env, q) {
  const id = q.get('id')
  const i = int(q.get('i')), n = int(q.get('n'))
  if (!id || !/^\d{1,16}$/.test(id)) return err(400, 'bad id')
  const rawO = q.get('o')
  const text = await bodyText(request)
  let data
  if (rawO != null) {
    if (!/^\d{1,9}$/.test(rawO) || Number(rawO) >= MAX_MEMO_BYTES) return err(400, 'bad chunk offset')
  } else if (n < 1 || n > MAX_CHUNKS || i < 0 || i >= n) return err(400, 'bad chunk index')
  try { data = b64decode(text) } catch (e) { return err(400, 'bad base64') }
  if (rawO != null) {
    if (data.length === 0) return err(400, 'empty chunk')
    if (data.length > MAX_CHUNK_BYTES) return err(413, 'chunk too big: ' + data.length)
  }
  // A resend for a memo that is already saved (the watch lost our commit
  // reply) must not add bytes to the stored copy: answer ok, store nothing.
  const saved = await env.DB.prepare('SELECT 1 AS x FROM memos WHERE id = ?').bind(id).first()
  if (!saved) {
    const kind = rawO != null ? 'o' : 'i'
    const pos = rawO != null ? Number(rawO) : i
    await env.DB.prepare('INSERT OR REPLACE INTO chunks (memo_id, kind, pos, n, len, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, kind, pos, rawO != null ? -1 : n, data.length, data, Date.now()).run()
  }
  return rawO != null ? ok({ i, o: Number(rawO), len: data.length }) : ok({ i })
}

async function logPart(request, env, q) {
  const id = q.get('id')
  const i = int(q.get('i')), n = int(q.get('n'))
  if (!id || !/^\d{1,16}$/.test(id)) return err(400, 'bad id')
  if (n < 1 || n > 512 || i < 0 || i >= n) return err(400, 'bad part index')
  let data
  try { data = b64decode(await bodyText(request)) } catch (e) { return e.status ? err(e.status, e.message) : err(400, 'bad base64') }
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM logparts WHERE id = ? AND n != ?').bind(id, n),
    env.DB.prepare('INSERT OR REPLACE INTO logparts (id, i, n, data, at) VALUES (?, ?, ?, ?, ?)').bind(id, i, n, data, now)
  ])
  const rows = (await env.DB.prepare('SELECT i, data FROM logparts WHERE id = ? ORDER BY i').bind(id).all()).results
  if (rows.length < n) return ok({ i, done: false })
  const all = concat(rows.map((r) => u8(r.data)))
  const p = localParts(now, NaN, env.TIMEZONE)
  const day = dayOf(p)
  const stem = 'watch-log-' + pad2(p.h) + pad2(p.mi) + pad2(p.s)
  let name = stem + '.txt'
  for (let k = 2; await env.DB.prepare('SELECT 1 AS x FROM logs WHERE name = ?').bind(day + '/' + name).first(); k++) name = stem + '-' + k + '.txt'
  await env.DB.batch([
    env.DB.prepare('INSERT INTO logs (name, day, data, created) VALUES (?, ?, ?, ?)').bind(day + '/' + name, day, all, now),
    env.DB.prepare('DELETE FROM logparts WHERE id = ?').bind(id)
  ])
  return ok({ i, done: true, file: name })
}

// Walks the offset chunks from byte 0: each next part must start where the last
// ended; stale parts off the path are ignored (and deleted after a good commit).
export function assemble(rows, size) {
  if (size < 0 || size > MAX_MEMO_BYTES) return { problem: 'bad size ' + size }
  const byPos = new Map(rows.map((r) => [r.pos, r]))
  const path = []
  let at = 0
  while (at < size) {
    const r = byPos.get(at)
    if (!r) return { problem: 'missing bytes from offset ' + at }
    if (at + r.len > size) return { problem: 'size/crc mismatch: chunk at ' + at + ' runs past the end (' + size + ')' }
    path.push(r)
    at += r.len
  }
  return { path, raw: concat(path.map((r) => u8(r.data))) }
}

async function commit(request, env) {
  const f = new URLSearchParams(await request.text())
  const id = f.get('id')
  if (!id || !/^\d{1,16}$/.test(id)) return err(400, 'bad id')
  const wantSize = int(f.get('size')), wantCrc = int(f.get('crc'))
  const DB = env.DB

  const prev = await DB.prepare('SELECT size, crc, file FROM memos WHERE id = ?').bind(id).first()
  if (prev) {
    await DB.prepare('DELETE FROM chunks WHERE memo_id = ? AND at > (SELECT created FROM memos WHERE id = ?)').bind(id, id).run()
    if (prev.size === wantSize && prev.crc === wantCrc) return ok({ size: prev.size, crc: prev.crc, file: prev.file, dup: true })
    return err(409, 'memo id already saved with different content')
  }

  const rows = (await DB.prepare('SELECT kind, pos, n, len, data FROM chunks WHERE memo_id = ? ORDER BY kind, pos').bind(id).all()).results
  const oRows = rows.filter((r) => r.kind === 'o')
  const iRows = rows.filter((r) => r.kind === 'i')
  let raw, mode, keep
  if (oRows.length && (f.get('mode') === 'o' || iRows.length === 0)) {
    const a = assemble(oRows, wantSize)
    if (a.problem) {
      if (a.problem.startsWith('size/crc mismatch')) await DB.prepare('DELETE FROM chunks WHERE memo_id = ? AND kind = ?').bind(id, 'o').run()
      return err(409, a.problem)
    }
    raw = a.raw; mode = 'o'; keep = new Set(a.path.map((r) => r.pos))
  } else {
    if (!iRows.length) return err(409, 'no chunks received for this memo')
    const n = iRows[iRows.length - 1].n
    const have = iRows.filter((r) => r.n === n)
    const byI = new Map(have.map((r) => [r.pos, r]))
    const missing = []
    for (let k = 0; k < n && missing.join(',').length < 60; k++) if (!byI.has(k)) missing.push(k)
    if (missing.length) return err(409, 'missing chunks ' + missing.join(','))
    const ordered = []
    for (let k = 0; k < n; k++) ordered.push(byI.get(k))
    raw = concat(ordered.map((r) => u8(r.data))); mode = 'i'; keep = new Set(ordered.map((r) => r.pos))
  }
  const c = crc32(raw)
  if (raw.length !== wantSize || c !== wantCrc) {
    await DB.prepare('DELETE FROM chunks WHERE memo_id = ?').bind(id).run()
    return err(409, 'size/crc mismatch: got ' + raw.length + '/' + c + ', watch said ' + wantSize + '/' + wantCrc)
  }

  let t = int(f.get('t'))
  if (t <= 0) t = Number(id)
  const tzRaw = f.get('tz')
  const tz = tzRaw != null && tzRaw !== '' ? Number(tzRaw) : NaN
  const p = localParts(t, tz, env.TIMEZONE)
  const day = dayOf(p)
  const time = pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s)
  const stem = pad2(p.h) + pad2(p.mi) + '-' + pad2(p.s)
  const taken = new Set((await DB.prepare('SELECT file FROM memos WHERE day = ?').bind(day).all()).results.map((r) => r.file))
  let file = stem + '.ogg'
  for (let k = 2; taken.has(file); k++) file = stem + '-' + k + '.ogg'

  const fix = f.get('fix') === '1'
  const meta = {
    recMs: num(f.get('recMs')), watchAudioMs: num(f.get('audioMs')), scrOff: num(f.get('scrOff')), scrOffMs: num(f.get('scrOffMs')),
    maxGapMs: num(f.get('maxGapMs')), sats: num(f.get('sats')), gpsWaitS: num(f.get('gpsWaitS')), fix,
    lat: fix ? num(f.get('lat')) : null, lon: fix ? num(f.get('lon')) : null, fixS: num(f.get('fixS')),
    keepOn: f.get('keepOn') === '1', stopKey: clean(f.get('stopKey')), note: clean(f.get('note'))
  }
  if (fix && (meta.lat === -1 && meta.lon === -1)) { meta.fix = false; meta.lat = meta.lon = null }

  const stmts = [
    DB.prepare('INSERT INTO memos (id, day, time, file, t, tz, size, crc, mode, meta, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, day, time, file, t, Number.isFinite(tz) ? tz : null, raw.length, c, mode, JSON.stringify(meta), Date.now()),
    // only the verified path stays
    DB.prepare('DELETE FROM chunks WHERE memo_id = ? AND kind != ?').bind(id, mode)
  ]
  for (const r of rows) if (r.kind === mode && !keep.has(r.pos)) stmts.push(DB.prepare('DELETE FROM chunks WHERE memo_id = ? AND kind = ? AND pos = ?').bind(id, mode, r.pos))
  await DB.batch(stmts)
  return ok({ size: raw.length, crc: c, file, dup: false })
}

function clean(v) { return v == null || v === 'undefined' || v === 'null' ? '' : String(v).slice(0, 500) }

// ---------- memo page API

async function api(request, env, url) {
  const DB = env.DB
  const path = url.pathname
  if (request.method === 'GET' && path === '/api/days') {
    const r = await DB.prepare('SELECT day, count(*) AS n, sum(size) AS bytes FROM memos GROUP BY day ORDER BY day DESC').all()
    return ok({ days: r.results })
  }
  if (request.method === 'GET' && path === '/api/memos') {
    const day = url.searchParams.get('day') || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err(400, 'bad day')
    const r = await DB.prepare('SELECT id, day, time, file, t, tz, size, crc, mode, meta FROM memos WHERE day = ? ORDER BY t').bind(day).all()
    return ok({ memos: r.results.map((m) => Object.assign(m, { meta: JSON.parse(m.meta) })) })
  }
  let m = path.match(/^\/api\/memo\/(\d{1,16})\/raw$/)
  if (request.method === 'GET' && m) {
    const memo = await DB.prepare('SELECT mode, size, crc FROM memos WHERE id = ?').bind(m[1]).first()
    if (!memo) return err(404, 'no such memo')
    const rows = (await DB.prepare('SELECT data FROM chunks WHERE memo_id = ? AND kind = ? ORDER BY pos').bind(m[1], memo.mode).all()).results
    const raw = concat(rows.map((r) => u8(r.data)))
    if (raw.length !== memo.size) return err(500, 'stored copy has ' + raw.length + ' bytes, expected ' + memo.size)
    return new Response(raw, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Memo-Crc': String(memo.crc) } })
  }
  m = path.match(/^\/api\/memo\/(\d{1,16})$/)
  if (request.method === 'DELETE' && m) {
    const memo = await DB.prepare('SELECT 1 AS x FROM memos WHERE id = ?').bind(m[1]).first()
    if (!memo) return err(404, 'no such memo')
    await DB.batch([DB.prepare('DELETE FROM chunks WHERE memo_id = ?').bind(m[1]), DB.prepare('DELETE FROM memos WHERE id = ?').bind(m[1])])
    return ok({ deleted: m[1] })
  }
  if (request.method === 'GET' && path === '/api/logs') {
    const day = url.searchParams.get('day') || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err(400, 'bad day')
    const r = await DB.prepare('SELECT name, length(data) AS bytes FROM logs WHERE day = ? ORDER BY name').bind(day).all()
    return ok({ logs: r.results })
  }
  m = path.match(/^\/api\/log\/(\d{4}-\d{2}-\d{2}\/watch-log-[\d-]+\.txt)$/)
  if (request.method === 'GET' && m) {
    const r = await DB.prepare('SELECT data FROM logs WHERE name = ?').bind(m[1]).first()
    if (!r) return err(404, 'no such log')
    return new Response(u8(r.data), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  return err(404, 'no route ' + request.method + ' ' + path)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!env.TOKEN || String(env.TOKEN).length < 16) return err(503, 'server token not set (npx wrangler secret put TOKEN, at least 16 characters)')
    // 0.3.2 (item 26a): optional per-IP rate limits (Cloudflare rate-limit bindings in
    // wrangler.toml; without them nothing is limited, e.g. in older deploys or tests).
    // BAD_TOKEN_RL: 10 wrong-token requests / 60 s per IP, then 429. RL: 600 requests / 60 s
    // per IP with the right token, far above the watch sender (one request at a time).
    const ip = request.headers.get('CF-Connecting-IP') || 'local'
    if (!authorised(request, env)) {
      if (env.BAD_TOKEN_RL && !(await env.BAD_TOKEN_RL.limit({ key: ip })).success) return err(429, 'too many bad tokens, wait a minute')
      return err(401, 'bad token')
    }
    if (env.RL && !(await env.RL.limit({ key: ip })).success) return err(429, 'too many requests, wait a minute')
    try {
      const p = url.pathname, method = request.method
      if (method === 'GET' && p === '/ping') return await ping(env)
      if (method === 'POST' && p === '/chunk') return await chunk(request, env, url.searchParams)
      if (method === 'POST' && p === '/logpart') return await logPart(request, env, url.searchParams)
      if (method === 'POST' && p === '/commit') return await commit(request, env)
      if (p.startsWith('/api/')) return await api(request, env, url)
      return err(404, 'no route ' + method + ' ' + p)
    } catch (e) {
      if (e && e.status) return err(e.status, e.message)
      return err(500, String((e && e.message) || e))
    }
  },

  // Daily: forget chunks/log parts of uploads that never completed.
  async scheduled(event, env) {
    const cutoff = Date.now() - STALE_MS
    if (env.DEMO === 'true') {
      // reviewer demo: keep nothing older than a day
      const day = Date.now() - 24 * 3600 * 1000
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chunks WHERE memo_id IN (SELECT id FROM memos WHERE created < ?)').bind(day),
        env.DB.prepare('DELETE FROM memos WHERE created < ?').bind(day),
        env.DB.prepare('DELETE FROM logs WHERE created < ?').bind(day)
      ])
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chunks WHERE at < ? AND memo_id NOT IN (SELECT id FROM memos)').bind(cutoff),
      env.DB.prepare('DELETE FROM logparts WHERE at < ?').bind(cutoff)
    ])
  }
}
