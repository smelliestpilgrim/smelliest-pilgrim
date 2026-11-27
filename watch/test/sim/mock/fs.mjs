import { W } from './env.mjs'
export const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_APPEND = 8, O_CREAT = 64, O_TRUNC = 512, O_EXCL = 128
const fds = new Map(); let nfd = 3
const guard = (path, op) => { if (W.recording && path === W.recording) W.violations.push(op + ' on audio file while recorder owns it') }
export function mkdirSync() {}
export function readdirSync({ path }) { return [...W.files.keys()].filter((k) => k.startsWith(path + '/')).map((k) => k.slice(path.length + 1)) }
export function writeFileSync({ path, data }) { W.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)) }
export function readFileSync({ path, options }) {
  guard(path, 'readFileSync')
  const d = W.files.get(path); if (!d) return undefined
  return options && options.encoding ? new TextDecoder().decode(d) : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
}
export function statSync({ path }) { if (path.endsWith('.opus')) { W.stats = (W.stats || 0) + 1; guard(path, 'statSync') } const d = W.files.get(path); return d ? { size: d.length } : undefined }
export function rmSync({ path }) { W.files.delete(path); W.log.push('rm ' + path) }
export function renameSync({ oldPath, newPath }) { W.files.set(newPath, W.files.get(oldPath)); W.files.delete(oldPath) }
export function openSync({ path, flag }) {
  guard(path, 'openSync')
  if (path.endsWith('.opus') && !flag) W.opusReads = (W.opusReads || 0) + 1
  if (!W.files.has(path)) { if (flag & O_CREAT) W.files.set(path, new Uint8Array(0)); else throw new Error('ENOENT') }
  fds.set(nfd, { path, flag: flag || 0 }); return nfd++
}
export function closeSync({ fd }) { fds.delete(fd) }
export function readSync({ fd, buffer, options }) {
  const d = W.files.get(fds.get(fd).path); const o = options || {}
  const len = Math.min(o.length ?? buffer.byteLength, d.length - (o.position || 0))
  new Uint8Array(buffer, o.offset || 0, len).set(d.subarray(o.position || 0, (o.position || 0) + len))
  return len
}
export function writeSync({ fd, buffer, options }) {
  const f = fds.get(fd); const o = options || {}
  const add = new Uint8Array(buffer, o.offset || 0, o.length ?? buffer.byteLength)
  const old = W.files.get(f.path) || new Uint8Array(0)
  const n = new Uint8Array(old.length + add.length); n.set(old); n.set(add, old.length)
  W.files.set(f.path, n); return add.length
}
