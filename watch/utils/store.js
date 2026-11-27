// Memo files on the watch, under data://memos/:
//   <id>.opus  raw recorder output (id = start time in epoch ms)
//   <id>.json  everything else about the memo, including the sent flag
// Nothing in here deletes a memo unless it is marked sent AND the phone
// confirmed the same size and CRC (see clearConfirmedSent).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, openSync, readSync, closeSync, O_RDONLY } from '@zos/fs'
import { MEMO_DIR } from './protocol'

export function ensureDir() {
  try {
    mkdirSync({ path: MEMO_DIR })
  } catch (e) {}
}

export function audioPath(id) {
  return MEMO_DIR + '/' + id + '.opus'
}
export function recorderTarget(id) {
  return 'data://' + audioPath(id)
}
function metaPath(id) {
  return MEMO_DIR + '/' + id + '.json'
}

export function audioSize(id) {
  try {
    const st = statSync({ path: audioPath(id) })
    return st ? st.size : 0
  } catch (e) {
    return 0
  }
}

export function saveMeta(memo) {
  writeFileSync({ path: metaPath(memo.id), data: JSON.stringify(memo), options: { encoding: 'utf8' } })
}

// Never throws: a half-written or corrupt .json (e.g. from a crash) gives null
// and the memo is still listed from its .opus.
export function loadMeta(id) {
  try {
    const st = statSync({ path: metaPath(id) })
    if (!st || !(st.size > 1) || st.size > 8192) return null
    const s = readFileSync({ path: metaPath(id), options: { encoding: 'utf8' } })
    if (typeof s !== 'string' || s.charAt(0) !== '{') return null
    const m = JSON.parse(s)
    return m && typeof m === 'object' && Number(m.id) === id ? m : null
  } catch (e) {
    return null
  }
}

// All memos, oldest first. An .opus without a .json (app killed mid-save)
// still shows up, with only what we can know.
export function listMemos() {
  let names = []
  try {
    names = readdirSync({ path: MEMO_DIR }) || []
  } catch (e) {
    names = []
  }
  const ids = {}
  names.forEach((n) => {
    const m = /^(\d+)\.(opus|json)$/.exec(n)
    if (m) ids[m[1]] = true
  })
  const out = []
  Object.keys(ids).forEach((k) => {
    try {
      const id = Number(k)
      if (!(id > 1500000000000)) return
      const meta = loadMeta(id) || { id, t: id, fix: false, note: 'no metadata (app closed early)' }
      meta.bytes = audioSize(id)
      out.push(meta)
    } catch (e) {}
  })
  out.sort((a, b) => a.id - b.id)
  return out
}

export function readAudio(id, offset, length) {
  const fd = openSync({ path: audioPath(id), flag: O_RDONLY })
  try {
    const buf = new ArrayBuffer(length)
    const got = readSync({ fd, buffer: buf, options: { offset: 0, length, position: offset } })
    const u = new Uint8Array(buf)
    return got === length ? u : u.subarray(0, Math.max(0, got || 0))
  } finally {
    try {
      closeSync({ fd })
    } catch (e) {}
  }
}

export function markSent(memo, reply) {
  const meta = loadMeta(memo.id) || memo
  meta.sent = true
  meta.sentAt = Date.now()
  meta.sentSize = Number(reply.size)
  meta.sentCrc = Number(reply.crc)
  meta.phoneFile = reply.file
  saveMeta(meta)
}

// Deletes only memos the phone confirmed byte-for-byte. Returns count.
export function clearConfirmedSent() {
  let n = 0
  listMemos().forEach((m) => {
    // 0.3.2: the old `skip` stub clause is gone. No 0.3.x file ever writes `skip`, and 0.3.x
    // (appId 1138450) never sees 0.1.x data, so it was dead code that could delete an
    // unconfirmed file. Only a memo the phone/server confirmed (size echoed) is deleted.
    const confirmed = m.sent === true && m.sentSize > 0 && m.sentSize === m.bytes
    if (confirmed) {
      try {
        rmSync({ path: audioPath(m.id) })
        rmSync({ path: metaPath(m.id) })
        n++
      } catch (e) {}
    }
  })
  return n
}
