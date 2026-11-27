import { W } from './env.mjs'
export function exit() { W.exited = true; W.log.push('exit'); if (W.geo && W.geo.started) W.violations.push('exit with GPS on'); if (W.recording && W.recording !== null && W.recOn) W.violations.push('exit while recording') }
export function replace(o) { W.replaced = o.url; W.log.push('replace ' + o.url); if (W.geo && W.geo.started) W.violations.push('navigate with GPS on') }
export function push(o) { W.pushed = o.url; W.log.push('push ' + o.url) }
