import { W } from './env.mjs'
export function setPageBrightTime(o) { W.log.push('bright ' + o.brightTime); return 0 }
export function resetPageBrightTime() { W.log.push('resetBright'); return 0 }
export function pauseDropWristScreenOff(o) { W.log.push('pauseDrop ' + o.duration); return 0 }
export function resetDropWristScreenOff() { W.log.push('resetDrop') }
