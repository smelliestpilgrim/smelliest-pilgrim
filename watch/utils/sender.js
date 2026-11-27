// "Send all" logic, kept free of @zos imports so node can drive it in tests.
// Callback style on purpose: the Zepp OS docs list Promise as unsupported on
// the device, so we only ever call .then() on what ZML's request() returns.
//
// io = {
//   readChunk(memo, offset, length) -> Uint8Array   (sync file read)
//   request({ method, params }) -> thenable          (ZML BasePage.request)
//   setTimeout(fn, ms) -> handle, clearTimeout(handle)
//   markSent(memo, reply)                             (persist sent flag)
//   now() -> ms
//   optional:
//   linkUp() -> bool          (BLE connected? @zos/ble connectStatus)
//   log(line)                 (breadcrumb log; every retry is logged)
//   loadResume(id) -> {n, i, crc, bytes} | null, saveResume(id, obj|null)
//   alive() -> bool           (false once the page is gone: stop quietly)
// }
//
// 0.1.3 reliability model
//   - every chunk and the commit go through step(): transient failures
//     (shake timeout, ble disconnect, side service down, phone app not
//     reachable, timeouts, HTTP 5xx) are retried with backoff
//     RETRY_DELAYS_MS until STALL_LIMIT_MS passes with no progress
//   - while BLE is down we poll linkUp() every second and retry as soon as it
//     is back, instead of burning tries
//   - the CRC only advances on a confirmed chunk, so a retry or resume
//     continues from the last chunk the phone acknowledged
//   - the phone stores chunks by index and overwrites duplicates, and a
//     repeated commit of a saved memo returns dup=true: retries are idempotent
//   - if the phone lost its partial copy (app restarted), commit says
//     "missing chunks"/"no chunks received": the memo restarts from chunk 0
//     once
//   - a step that gives up saves {i, crc} so the next press resumes there
//   - the memo is only marked sent when the phone echoes size + CRC-32
//
// 0.1.4 chunk sizes
//   - the chunk size comes from a size context (sizeCtx) shared by one send
//     run: 2, 5, 10 or 16 KB (CHUNK_SIZES), picked on the Send page
//   - adaptive fallback: FALLBACK_AFTER size-type errors on the same chunk
//     (timeouts, "send message error", receive/length errors, HTTP 413/5xx)
//     drop to the next smaller size for the rest of the run, logged. Errors
//     that are not about size (BLE down, shake timeout, phone app closed)
//     never drop the size: the 0.1.3 waits handle those
//   - the send position is a byte offset. With WatchMemo 0.2.2 (ping says
//     offsets:true) chunks carry o=<byte offset> and the phone assembles by
//     offset, so a size change, or a resume with another size, carries on at
//     the same byte. With an older phone (index mode) a size change restarts
//     the memo at the new size, because the phone numbers chunks by index
//   - per memo: chunk size and KB/s are logged and reported in the 'sent'
//     event; the run's 'done' event carries the final size and any drops
import { base64, crc32Update } from './codec'
import {
  CHUNK_BYTES, CHUNK_TIMEOUT_MS, CHUNK_RETRIES, COMMIT_TIMEOUT_MS,
  RETRY_DELAYS_MS, STALL_LIMIT_MS, LOG_STALL_LIMIT_MS, LINK_POLL_MS, LINK_SETTLE_MS,
  CHUNK_SIZES, FALLBACK_AFTER, chunkTimeout, chunkLabel
} from './protocol'

export function requestWithTimeout(io, data, ms, cb) {
  let done = false
  const t = io.setTimeout(() => {
    if (done) return
    done = true
    cb('timeout after ' + Math.round(ms / 1000) + ' s', null)
  }, ms)
  let p
  try {
    p = io.request(data)
  } catch (e) {
    done = true
    io.clearTimeout(t)
    cb('request threw: ' + (e && e.message ? e.message : e), null)
    return
  }
  p.then(
    (r) => {
      if (done) return
      done = true
      io.clearTimeout(t)
      cb(null, r)
    },
    (e) => {
      if (done) return
      done = true
      io.clearTimeout(t)
      cb('link error: ' + (e && e.message ? e.message : JSON.stringify(e)), null)
    }
  )
}

// What is wrong, in words for the watch screen.
export function linkKind(why) {
  const s = String(why || '')
  if (/ble disconnect/i.test(s)) return 'ble'
  if (/shake timeout|side service/i.test(s)) return 'zepp'
  if (/server/i.test(s)) return 'server' // 0.2.0: 'My server' destination
  if (/not reachable|refused/i.test(s)) return 'phone'
  return 'other'
}
export function linkHint(kind) {
  if (kind === 'ble') return 'Watch not connected to phone. Waiting...'
  if (kind === 'zepp') return 'Zepp app not answering. Keep phone near.'
  if (kind === 'phone') return 'Open Smelliest Pilgrim on phone'
  if (kind === 'server') return 'Server not reachable. Phone online?'
  return 'No reply from phone. Retrying...'
}

// A phone refusal (HTTP 4xx) is a real answer; everything else may pass.
function isPermanent(err, r) {
  return !err && r && typeof r.status === 'number' && r.status >= 400 && r.status < 500
}

const alive = (io) => !io.alive || io.alive()
const logIt = (io, line) => { if (io.log) { try { io.log(line) } catch (e) {} } }

// One request, retried until it succeeds, the phone refuses it (4xx), or
// stallMs passes. cb(err, reply, permanent). onRetry({ label, tries, delay,
// why, kind }) fires before every wait.
// opts.onFail(why, kind, reply) -> true stops the step at once with
// cb(why, reply, false, true): the caller wants to retry it differently
// (0.1.4: a smaller chunk).
export function step(io, label, data, timeoutMs, stallMs, onRetry, cb, opts) {
  const t0 = io.now()
  let tries = 0 // tries made while the link was up
  let attempts = 0
  function attempt() {
    if (!alive(io)) return
    attempts++
    requestWithTimeout(io, data, timeoutMs, (err, r) => {
      if (!alive(io)) return
      if (!err && r && r.ok) {
        if (attempts > 1) logIt(io, label + ' ok on try ' + attempts)
        return cb(null, r, false)
      }
      const why = err || (r && r.error) || 'phone said no'
      const kind = linkKind(why)
      if (opts && opts.onFail) {
        let stop = false
        try { stop = !!opts.onFail(why, kind, r) } catch (e) {}
        if (stop) return cb(why, r, false, true)
      }
      if (isPermanent(err, r)) return cb(why, r, true)
      if (kind !== 'ble') tries++
      const waited = io.now() - t0
      if (tries >= CHUNK_RETRIES || waited >= stallMs) {
        logIt(io, label + ' gave up after ' + attempts + ' tries, ' + Math.round(waited / 1000) + ' s: ' + why)
        return cb(why + ' (gave up after ' + attempts + ' tries, ' + Math.round(waited / 1000) + ' s)', r, false)
      }
      const delay = Math.min(RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)], Math.max(1000, stallMs - waited))
      logIt(io, 'retry ' + label + ' #' + (attempts + 1) + ' in ' + Math.round(delay / 1000) + 's: ' + why)
      if (onRetry) { try { onRetry({ label, tries: attempts, delay, why, kind }) } catch (e) {} }
      wait(delay, kind)
    })
  }
  function wait(delay, kind) {
    if (kind !== 'ble' || !io.linkUp) return io.setTimeout(attempt, delay)
    // BLE down: check every second; retry shortly after it is back.
    const until = io.now() + delay
    let wasDown = false
    function poll() {
      if (!alive(io)) return
      let up = false
      try { up = !!io.linkUp() } catch (e) {}
      if (!up) wasDown = true
      if (up && wasDown) return io.setTimeout(attempt, LINK_SETTLE_MS)
      if (io.now() >= until) return attempt()
      io.setTimeout(poll, LINK_POLL_MS)
    }
    io.setTimeout(poll, LINK_POLL_MS)
  }
  attempt()
}

export function commitParams(memo, size, n, crc) {
  return {
    id: memo.id,
    n,
    size,
    crc,
    t: memo.t,
    tz: memo.tz,
    lat: memo.fix ? memo.lat : undefined,
    lon: memo.fix ? memo.lon : undefined,
    fix: memo.fix ? 1 : 0,
    fixS: memo.fixS,
    sats: memo.sats,
    recMs: memo.recMs,
    audioMs: memo.audioMs,
    scrOff: memo.scrOff,
    scrOffMs: memo.scrOffMs,
    maxGapMs: memo.maxGapMs,
    keepOn: memo.keepOn ? 1 : 0,
    stopKey: memo.stopKey,
    gpsWaitS: memo.gpsWaitS,
    note: memo.note
  }
}

// Errors that may be caused by the chunk being too big for some layer
// (ZML/BLE queue, Zepp app, phone server). Link-down and app-closed errors
// are not: they are waited out at the same size.
// phoneSeen: the phone app answered earlier in this run (ping or a chunk).
// Then "not reachable" on a big chunk may be the Zepp app's fetch refusing
// the body rather than WatchMemo being closed, so it counts too.
export function sizeError(why, kind, r, phoneSeen) {
  if (r && (r.status === 413 || /too big|too large/i.test(String(r.error || '')))) return true
  if (r && typeof r.status === 'number' && r.status >= 500) return true
  if (r && typeof r.status === 'number' && r.status >= 400) return false // a real refusal (0.2.0: e.g. bad server token)
  if (kind === 'phone' || kind === 'server') return !!phoneSeen
  if (kind !== 'other') return false
  return /timeout|send message error|request threw|length error|receive data error|queue limit|exceeded|HTTP 5\d\d|memory/i.test(String(why || ''))
}

// One shared chunk-size state per send run.
//   sizes: ascending list; idx: current index; drops: log of drops
export function makeSizeCtx(chunkBytes, offsets, sizes) {
  const list = (sizes || CHUNK_SIZES).slice().sort((a, b) => a - b)
  let idx = list.indexOf(chunkBytes)
  if (idx < 0) {
    idx = 0
    for (let k = 0; k < list.length; k++) if (list[k] <= chunkBytes) idx = k
  }
  return { sizes: list, idx, start: list[idx], offsets: !!offsets, drops: [], phoneSeen: false }
}
const curSize = (ctx) => ctx.sizes[ctx.idx]

// Sends one memo; cb(err, reply, permanent, stats). Never deletes anything.
// onProgress(sentBytes, size); onRetry(info) while waiting to retry.
// ctx: makeSizeCtx(...) shared by the run; default = one fixed 2 KB size
// (0.1.3 behaviour) unless io.chunkBytes / io.offsets say otherwise.
export function sendMemo(io, memo, onProgress, cb, onRetry, ctx) {
  const size = memo.bytes
  if (!(size > 0)) return cb('empty recording, skipped', null, true)
  if (!ctx) ctx = makeSizeCtx(io.chunkBytes || CHUNK_BYTES, io.offsets, io.chunkBytes ? null : [CHUNK_BYTES])
  const mode = ctx.offsets ? 'o' : 'i'
  let cs = curSize(ctx)
  let n = Math.ceil(size / cs)
  let crc = 0
  let off = 0 // confirmed bytes
  let restarted = false
  let sizeErrs = 0
  const t0 = io.now()
  let sentBytes = 0 // bytes actually carried this time (incl. resends)
  const sizesUsed = [cs]

  let saved = null
  try { saved = io.loadResume ? io.loadResume(memo.id) : null } catch (e) {}
  if (saved && saved.bytes === size && typeof saved.crc === 'number') {
    // 0.1.3 notes have no cs/mode: they were 2 KB index chunks
    const sCs = saved.cs || CHUNK_BYTES
    const sMode = saved.mode || 'i'
    const sOff = typeof saved.off === 'number' ? saved.off : saved.i * sCs
    if (sOff > 0 && sOff <= size) {
      if (mode === 'o' && sMode === 'o') {
        off = sOff; crc = saved.crc
      } else if (mode === 'i' && sMode === 'i' && sCs === cs && saved.n === n) {
        off = sOff; crc = saved.crc
      } else if (mode === 'o' && sMode === 'i') {
        // old index chunks on the phone are not in its offset store
        logIt(io, 'memo ' + memo.id + ' resume note was ' + chunkLabel(sCs) + ' index chunks, starting again with ' + chunkLabel(cs) + ' offset chunks')
      } else {
        logIt(io, 'memo ' + memo.id + ' resume note was ' + chunkLabel(sCs) + ' chunks, now ' + chunkLabel(cs) + ': starting again')
      }
      if (off > 0) logIt(io, 'memo ' + memo.id + ' resumes at byte ' + off + '/' + size + ' (chunk ' + (Math.floor(off / cs) + 1) + '/' + n + ', ' + chunkLabel(cs) + ')')
    }
  }
  const remember = () => { try { if (io.saveResume) io.saveResume(memo.id, off > 0 ? { n, i: Math.floor(off / cs), off, cs, mode, crc, bytes: size } : null) } catch (e) {} }
  const forget = () => { try { if (io.saveResume) io.saveResume(memo.id, null) } catch (e) {} }
  const progress = () => { if (onProgress) onProgress(Math.min(size, off), size) }

  function restart(why) {
    logIt(io, 'memo ' + memo.id + ' restarts from chunk 1: ' + why)
    restarted = true
    off = 0
    crc = 0
    forget()
    progress()
    nextChunk()
  }

  // Drop to the next smaller size for the rest of the run.
  function dropSize(why) {
    const from = cs
    ctx.idx--
    cs = curSize(ctx)
    n = Math.ceil(size / cs)
    sizeErrs = 0
    if (sizesUsed.indexOf(cs) < 0) sizesUsed.push(cs)
    const line = 'chunk size ' + chunkLabel(from) + ' -> ' + chunkLabel(cs) + ' for the rest of this send, after ' + FALLBACK_AFTER + ' errors at byte ' + off + ': ' + why
    ctx.drops.push({ from, to: cs, memo: memo.id, at: off, why: String(why).slice(0, 80) })
    logIt(io, line)
    if (mode === 'i' && off > 0) {
      // the old phone numbers chunks by index: the new size starts over
      off = 0
      crc = 0
      forget()
      logIt(io, 'memo ' + memo.id + ' restarts at ' + chunkLabel(cs) + ' (phone app is older than 0.2.2, no byte offsets)')
      progress()
    }
    nextChunk()
  }

  function nextChunk() {
    if (!alive(io)) return
    if (off >= size) return commit()
    // another memo in this run may have dropped the size meanwhile
    if (curSize(ctx) !== cs) {
      if (mode === 'o' || off === 0) {
        cs = curSize(ctx)
        n = Math.ceil(size / cs)
        if (sizesUsed.indexOf(cs) < 0) sizesUsed.push(cs)
      }
    }
    const len = Math.min(cs, size - off)
    let bytes
    try {
      bytes = io.readChunk(memo, off, len)
    } catch (e) {
      return cb('read failed at byte ' + off + ': ' + e, null, true)
    }
    if (!bytes || bytes.length !== len) return cb('short read at byte ' + off, null, true)
    const i = Math.floor(off / cs)
    const params = { id: memo.id, i, n, d: base64(bytes) }
    if (mode === 'o') params.o = off
    sizeErrs = 0
    const canDrop = ctx.idx > 0
    const opts = canDrop ? {
      onFail: (why, kind, r) => {
        if (!sizeError(why, kind, r, ctx.phoneSeen)) return false
        sizeErrs++
        return sizeErrs >= FALLBACK_AFTER || (r && r.status === 413)
      }
    } : null
    const label = 'chunk ' + (i + 1) + '/' + n
    step(io, label, { method: 'chunk', params }, chunkTimeout(len), STALL_LIMIT_MS, onRetry, (err, r, perm, drop) => {
      if (drop) return dropSize(err)
      if (err) {
        remember()
        return cb('chunk ' + (i + 1) + '/' + n + ': ' + err, null, perm)
      }
      crc = crc32Update(crc, bytes) // only confirmed bytes count
      ctx.phoneSeen = true
      off += len
      sentBytes += len
      progress()
      nextChunk()
    }, opts)
  }

  function commit() {
    const params = commitParams(memo, size, n, crc)
    if (mode === 'o') params.mode = 'o'
    step(io, 'commit', { method: 'commit', params }, COMMIT_TIMEOUT_MS, STALL_LIMIT_MS, onRetry, (err, r, perm) => {
      if (err) {
        // Phone lost (part of) its copy, or it did not add up: start over once.
        if (perm && !restarted && /missing|no chunks received|mismatch/i.test(err)) return restart(err)
        if (!perm) remember()
        else forget()
        return cb('commit: ' + err, null, perm)
      }
      // Only trust a save the phone describes back to us byte-for-byte.
      if (Number(r.size) !== size || Number(r.crc) !== crc) {
        if (!restarted) return restart('phone copy does not match (size/crc)')
        forget()
        return cb('commit: phone copy does not match (size/crc)', null, true)
      }
      forget()
      const secs = Math.max(0.001, (io.now() - t0) / 1000)
      const stats = { bytes: size, carried: sentBytes, secs, kbps: sentBytes / 1024 / secs, cs, sizes: sizesUsed.slice(), mode }
      logIt(io, 'memo ' + memo.id + ' sent: ' + (size / 1024).toFixed(1) + ' KB in ' + secs.toFixed(1) + ' s = ' + stats.kbps.toFixed(2) + ' KB/s, chunk ' + sizesUsed.map(chunkLabel).join('->') + ' (' + (mode === 'o' ? 'offsets' : 'index') + ')' + (r.dup ? ', dup' : ''))
      cb(null, r, false, stats)
    })
  }

  progress()
  nextChunk()
}

// Sends every unsent memo, oldest first, one after another.
// onEvent({ type: 'memo'|'progress'|'retry'|'sent'|'failed'|'done', ... })
export function sendAll(io, memos, onEvent) {
  const todo = memos.filter((m) => !m.sent && !m.skip && m.bytes > 0).sort((a, b) => a.id - b.id)
  const total = todo.length
  const totalBytes = todo.reduce((s, m) => s + m.bytes, 0)
  const t0 = io.now()
  const ctx = makeSizeCtx(io.chunkBytes || CHUNK_BYTES, io.offsets, io.chunkBytes ? null : [CHUNK_BYTES])
  ctx.phoneSeen = !!io.phoneOk
  logIt(io, 'send run: chunk ' + chunkLabel(ctx.start) + ', ' + (ctx.offsets ? 'byte offsets (phone 0.2.2+)' : 'index chunks (older phone app or no ping yet)') + ', ' + total + ' memos, ' + (totalBytes / 1024).toFixed(1) + ' KB')
  let doneBytes = 0
  let ok = 0
  let failed = 0
  let retries = 0
  let lastErr = null
  let k = 0
  let linkDead = false
  let busySecs = 0 // time spent on memos that went through
  const perMemo = []

  function next() {
    if (!alive(io)) return
    if (k >= total) {
      const secs = Math.max(0.001, (io.now() - t0) / 1000)
      return onEvent({
        type: 'done', ok, failed, total, notTried: total - ok - failed, lastErr, linkDead, retries, secs,
        kbps: doneBytes / 1024 / secs,
        memoKbps: busySecs > 0 ? doneBytes / 1024 / busySecs : 0,
        chunkStart: ctx.start, chunkEnd: curSize(ctx), drops: ctx.drops.slice(), offsets: ctx.offsets, perMemo
      })
    }
    const memo = todo[k]
    onEvent({ type: 'memo', index: k + 1, total, memo, chunk: curSize(ctx) })
    sendMemo(
      io,
      memo,
      (b, size) => {
        const secs = Math.max(0.001, (io.now() - t0) / 1000)
        onEvent({ type: 'progress', index: k + 1, total, bytes: b, size, allBytes: doneBytes + b, totalBytes, kbps: (doneBytes + b) / 1024 / secs, chunk: curSize(ctx) })
      },
      (err, reply, perm, stats) => {
        if (err) {
          failed++
          lastErr = err
          onEvent({ type: 'failed', index: k + 1, total, memo, error: err, permanent: !!perm })
          // Retries already waited STALL_LIMIT_MS: the link is gone, stop.
          if (!perm) {
            linkDead = true
            k = total
            return next()
          }
        } else {
          ok++
          doneBytes += memo.bytes
          if (stats) { busySecs += stats.secs; perMemo.push({ id: memo.id, kb: memo.bytes / 1024, secs: stats.secs, kbps: stats.kbps, cs: stats.cs }) }
          try {
            io.markSent(memo, reply)
          } catch (e) {}
          onEvent({ type: 'sent', index: k + 1, total, memo, reply, stats })
        }
        k++
        next()
      },
      (info) => {
        retries++
        onEvent(Object.assign({ type: 'retry', index: k + 1, total, memo }, info))
      },
      ctx
    )
  }
  next()
  return { total, totalBytes }
}

// Sends a text file (the breadcrumb log) in base64 parts; cb(err, reply).
export function sendText(io, bytes, onProgress, cb, onRetry) {
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES))
  const id = io.now()
  let i = 0
  function next() {
    if (i >= n) return
    const part = bytes.subarray(i * CHUNK_BYTES, Math.min(bytes.length, (i + 1) * CHUNK_BYTES))
    const params = { id, i, n, d: base64(part) }
    step(io, 'log part ' + (i + 1) + '/' + n, { method: 'logpart', params }, CHUNK_TIMEOUT_MS, LOG_STALL_LIMIT_MS, onRetry, (err, r) => {
      if (err) return cb('log part ' + (i + 1) + '/' + n + ': ' + err, null)
      i++
      if (onProgress) onProgress(i, n)
      if (i >= n) return cb(null, r)
      next()
    })
  }
  next()
}
