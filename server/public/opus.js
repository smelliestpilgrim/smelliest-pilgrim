// Zepp watch recording -> standard Ogg Opus, in plain JS (browser and node).
// A line-by-line port of the WatchMemo Android app's ZeppOpus.java + OggOpus.java:
// the watch writes Opus packets in the opus_demo layout (per packet: 4-byte
// big-endian length, 4 bytes of encoder range state, then the packet), 16 kHz mono.

export function samples48k(pkt) {
  if (pkt.length < 1) return 0
  const toc = pkt[0]
  const config = toc >> 3
  let frame
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]
  else if (config < 16) frame = [480, 960][config & 1]
  else frame = [120, 240, 480, 960][config & 3]
  const code = toc & 3
  let count
  if (code === 0) count = 1
  else if (code === 1 || code === 2) count = 2
  else count = pkt.length > 1 ? pkt[1] & 0x3f : 0
  return frame * count
}

export function parseZepp(data) {
  const packets = []
  let off = 0, samples = 0
  while (off + 8 <= data.length) {
    const len = data[off] * 0x1000000 + (data[off + 1] << 16) + (data[off + 2] << 8) + data[off + 3]
    if (len <= 0 || len > 1275 * 3 || off + 8 + len > data.length) break
    const pkt = data.subarray(off + 8, off + 8 + len)
    packets.push(pkt)
    samples += samples48k(pkt)
    off += 8 + len
  }
  return { packets, usedBytes: off, totalBytes: data.length, truncated: off !== data.length, durationMs: Math.floor(samples / 48) }
}

const OGG_CRC = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let r = i << 24
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
  OGG_CRC[i] = r >>> 0
}
function oggCrc(b) {
  let c = 0
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0
  return c >>> 0
}

export const PRE_SKIP = 312
const MAX_PAGE_PAYLOAD = 4000

function le16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff }
function le32(b, o, v) { for (let i = 0; i < 4; i++) b[o + i] = (v >>> (8 * i)) & 0xff }

function page(out, type, granule, serial, seq, pkts) {
  const segs = []
  let body = 0
  for (const p of pkts) {
    let n = p.length
    while (n >= 255) { segs.push(255); n -= 255 }
    segs.push(n)
    body += p.length
  }
  const p = new Uint8Array(27 + segs.length + body)
  p.set([0x4f, 0x67, 0x67, 0x53, 0, type], 0)
  let g = BigInt(granule)
  for (let i = 0; i < 8; i++) { p[6 + i] = Number(g & 0xffn); g >>= 8n }
  le32(p, 14, serial); le32(p, 18, seq); le32(p, 22, 0)
  p[26] = segs.length
  p.set(segs, 27)
  let o = 27 + segs.length
  for (const q of pkts) { p.set(q, o); o += q.length }
  le32(p, 22, oggCrc(p))
  out.push(p)
}

// packets: Array<Uint8Array>; returns Uint8Array (a complete .ogg file).
export function buildOgg(packets, inputRate, serial, title) {
  const out = []
  let seq = 0
  const enc = new TextEncoder()
  const head = new Uint8Array(19)
  head.set(enc.encode('OpusHead'), 0)
  head[8] = 1; head[9] = 1
  le16(head, 10, PRE_SKIP); le32(head, 12, inputRate); le16(head, 16, 0); head[18] = 0
  page(out, 0x02, 0, serial, seq++, [head])
  const vendor = enc.encode('WatchMemo')
  const comment = title == null ? null : enc.encode('TITLE=' + title)
  const tags = new Uint8Array(8 + 4 + vendor.length + 4 + (comment ? 4 + comment.length : 0))
  let o = 0
  tags.set(enc.encode('OpusTags'), 0); o = 8
  le32(tags, o, vendor.length); o += 4
  tags.set(vendor, o); o += vendor.length
  le32(tags, o, comment ? 1 : 0); o += 4
  if (comment) { le32(tags, o, comment.length); o += 4; tags.set(comment, o) }
  page(out, 0x00, 0, serial, seq++, [tags])
  let granule = 0
  if (packets.length === 0) page(out, 0x04, 0, serial, seq, [])
  let start = 0
  while (start < packets.length) {
    let end = start, bytes = 0, segs = 0
    while (end < packets.length) {
      const s = Math.floor(packets[end].length / 255) + 1
      if (end > start && (segs + s > 255 || bytes + packets[end].length > MAX_PAGE_PAYLOAD)) break
      segs += s; bytes += packets[end].length
      granule += samples48k(packets[end])
      end++
    }
    const last = end >= packets.length
    page(out, last ? 0x04 : 0x00, granule, serial, seq++, packets.slice(start, end))
    start = end
  }
  let total = 0
  for (const p of out) total += p.length
  const file = new Uint8Array(total)
  let at = 0
  for (const p of out) { file.set(p, at); at += p.length }
  return file
}

// Same serial/title as the phone app: serial = id & 0x7fffffff, title "YYYY-MM-DD HH:MM:SS".
export function zeppToOgg(raw, id, title) {
  const parsed = parseZepp(raw)
  const serial = Number(BigInt(id) & 0x7fffffffn)
  return { ogg: buildOgg(parsed.packets, 16000, serial, title), parsed }
}
