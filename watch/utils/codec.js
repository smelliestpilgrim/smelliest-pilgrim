// Pure helpers, no @zos imports, so they run in node for tests.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes) {
  let out = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
  }
  if (i < n) {
    const a = bytes[i]
    const b = i + 1 < n ? bytes[i + 1] : 0
    const v = (a << 16) | (b << 8)
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63]
    out += i + 1 < n ? B64[(v >> 6) & 63] + '=' : '=='
  }
  return out
}

// Standard CRC-32 (IEEE, same as java.util.zip.CRC32). Incremental:
// crc = crc32Update(0, a); crc = crc32Update(crc, b) ... result is unsigned.
let TABLE = null
function table() {
  if (TABLE) return TABLE
  TABLE = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    TABLE[n] = c >>> 0
  }
  return TABLE
}
export function crc32Update(crc, bytes) {
  const t = table()
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Opus TOC byte -> samples per packet at 48 kHz (RFC 6716 section 3.1).
export function opusPacketSamples48k(pkt) {
  if (!pkt || pkt.length < 1) return 0
  const toc = pkt[0]
  const config = toc >> 3
  let frame // in 48 kHz samples
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3] // SILK 10/20/40/60 ms
  else if (config < 16) frame = [480, 960][config & 1] // Hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config & 3] // CELT 2.5/5/10/20 ms
  const code = toc & 3
  let count
  if (code === 0) count = 1
  else if (code === 1 || code === 2) count = 2
  else count = pkt.length > 1 ? pkt[1] & 0x3f : 0
  return frame * count
}

// Walk the watch's recorder file (opus_demo layout: per packet a 4-byte
// big-endian length, a 4-byte encoder range value, then the packet).
// Returns { packets, audioMs, okBytes } without copying audio.
export function scanZeppOpus(bytes) {
  let off = 0
  let packets = 0
  let samples = 0
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
    if (len === 0 || len > 1275 * 3 || off + 8 + len > bytes.length) break
    const p = bytes.subarray(off + 8, off + 8 + len)
    samples += opusPacketSamples48k(p)
    packets++
    off += 8 + len
  }
  return { packets, audioMs: Math.round(samples / 48), okBytes: off }
}

export function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return Math.floor(s / 60) + ':' + pad2(s % 60)
}

// application/x-www-form-urlencoded encoding of a flat object (commit body).
export function formEncode(obj) {
  const parts = []
  for (const k in obj) {
    if (obj[k] === undefined || obj[k] === null) continue
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])))
  }
  return parts.join('&')
}
