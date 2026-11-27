import { W } from './env.mjs'
export const VIBRATOR_SCENE_SHORT_LIGHT = 0, VIBRATOR_SCENE_SHORT_MIDDLE = 1, VIBRATOR_SCENE_SHORT_STRONG = 2,
  VIBRATOR_SCENE_DURATION = 3, VIBRATOR_SCENE_DURATION_LONG = 4, VIBRATOR_SCENE_STRONG_REMINDER = 5,
  VIBRATOR_SCENE_NOTIFICATION = 6, VIBRATOR_SCENE_CALL = 7, VIBRATOR_SCENE_TIMER = 8
const NAMES = ['short_light', 'short_middle', 'short_strong', 'long600', 'long1000', 'four_quick', 'two_short', 'call', 'timer']
export class Vibrator {
  setMode(m) { this.m = m }
  start() { W.buzz.push(NAMES[this.m]) }
  stop() { W.vibStops = (W.vibStops || 0) + 1 }
}
export class Geolocation {
  constructor() { W.geo = this; W.geoCount = (W.geoCount || 0) + 1; this.status = 'V'; this.lat = 0; this.lon = 0; this.cbs = []; this.gcbs = []; this.calls = []; this.inCb = false }
  rec(n) { this.calls.push(n); if (this.inCb && (n === 'stop' || n === 'offChange')) W.violations.push('geo.' + n + ' inside onChange') }
  start() { this.rec('start'); if (this.started) W.violations.push('geo.start twice'); this.started = true }
  stop() { this.rec('stop'); if (this.gcbs.length) W.violations.push('geo.stop with a gnss listener still attached'); this.started = false }
  getStatus() { this.rec('getStatus'); if (!this.inCb) W.violations.push('getStatus polled outside onChange'); return this.status }
  getLatitude(o) { this.rec('getLatitude'); if (o !== undefined) W.violations.push('getLatitude called with args'); return this.lat }
  getLongitude(o) { this.rec('getLongitude'); return this.lon }
  onChange(cb) { this.rec('onChange'); this.cbs.push(cb) }
  offChange(cb) { this.rec('offChange'); this.cbs = this.cbs.filter((c) => c !== cb) }
  // 0.1.3: allowed only when the user opted in (satsOn=1); at most one listener
  onGnssChange(cb) { this.rec('onGnssChange'); if (W.storage.get('satsOn') !== '1') W.violations.push('onGnssChange without opt-in'); if (this.gcbs.length) W.violations.push('onGnssChange twice'); this.gcbs.push(cb) }
  offGnssChange(cb) { this.rec('offGnssChange'); if (this.inCb) W.violations.push('offGnssChange inside a callback'); this.gcbs = this.gcbs.filter((c) => c !== cb) }
  gnss(info) { this.inCb = true; try { this.gcbs.forEach((c) => c(info)) } finally { this.inCb = false } }
  emit() { this.inCb = true; try { this.cbs.forEach((c) => c()) } finally { this.inCb = false } }
  fixNow(lat, lon) { this.status = 'A'; this.lat = lat; this.lon = lon; this.emit() }
  count(n) { return this.calls.filter((c) => c === n).length }
}
export class Screen {
  constructor() { W.screen = this; this.st = 1; this.cbs = [] }
  getStatus() { return this.st }
  onChange(cb) { this.cbs.push(cb) }
  offChange(cb) { this.cbs = this.cbs.filter((c) => c !== cb) }
  set(st) { this.st = st; this.cbs.forEach((c) => c(st)) }
}
