import { W } from './env.mjs'
export function setTimeout(fn, ms) { const t = { id: ++W.seq, at: W.now + (ms || 0), fn }; W.timers.push(t); return t.id }
export function setInterval(fn, ms) { const t = { id: ++W.seq, at: W.now + ms, fn, every: ms }; W.timers.push(t); return t.id }
export function clearTimeout(id) { W.timers = W.timers.filter((t) => t.id !== id) }
export const clearInterval = clearTimeout
