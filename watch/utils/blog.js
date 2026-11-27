// Crash-safe breadcrumb log: data://memo_log.txt. Every line is opened,
// appended and closed at once, so it survives a watch reboot.
import { openSync, writeSync, closeSync, statSync, renameSync, rmSync, readFileSync, O_WRONLY, O_CREAT, O_APPEND } from '@zos/fs'
import { pad2 } from './codec'

export const LOG_PATH = 'memo_log.txt'
export const LOG_OLD = 'memo_log.1.txt'
const MAX_BYTES = 24 * 1024

function ascii(s) {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    b[i] = c < 128 ? c : 63 // '?'
  }
  return b
}

export function blog(text) {
  try {
    const d = new Date()
    const line = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + ' ' + String(text).slice(0, 160) + '\n'
    try {
      const st = statSync({ path: LOG_PATH })
      if (st && st.size > MAX_BYTES) {
        try { rmSync({ path: LOG_OLD }) } catch (e) {}
        renameSync({ oldPath: LOG_PATH, newPath: LOG_OLD })
      }
    } catch (e) {}
    const fd = openSync({ path: LOG_PATH, flag: O_WRONLY | O_CREAT | O_APPEND })
    try {
      const b = ascii(line)
      writeSync({ fd, buffer: b.buffer, options: { offset: 0, length: b.length } })
    } finally {
      closeSync({ fd })
    }
  } catch (e) {}
}

// Whole log as text (previous file first), or '' if none.
export function readLog() {
  let out = ''
  ;[LOG_OLD, LOG_PATH].forEach((p) => {
    try {
      const s = readFileSync({ path: p, options: { encoding: 'utf8' } })
      if (typeof s === 'string') out += s
    } catch (e) {}
  })
  return out
}

export function logBytes() {
  const s = readLog()
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f
  return b
}
