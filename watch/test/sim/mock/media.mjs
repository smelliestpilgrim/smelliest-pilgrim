import { W } from './env.mjs'
export const id = { RECORDER: 'REC', PLAYER: 'PLAY' }
export const codec = { OPUS: 'OPUS' }
export function create(kind) {
  W.recCreated = (W.recCreated || 0) + 1
  return {
    event: { START: 1, STOP: 2 },
    setFormat(c, o) { this.target = o.target_file.replace('data://', '') },
    start() { if (W.micBroken) throw new Error('mic busy'); this.on = true; W.recording = this.target; W.log.push('rec start ' + this.target); W.files.set(this.target, new Uint8Array(0)) },
    stop() {
      W.recStops = (W.recStops || 0) + 1
      if (!this.on) W.violations.push('recorder.stop twice / before start')
      this.on = false
      W.log.push('rec stop')
      const t = this.target, bytes = W.recorderBytes
      // file is being finalised for 400 ms after stop
      W.timers.push({ id: ++W.seq, at: W.now + 400, fn: () => { W.files.set(t, bytes); W.recording = null } })
      W.recording = t
    },
    addEventListener() {}
  }
}
