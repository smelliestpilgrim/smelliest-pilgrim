// Shared fake world: virtual clock, timers, filesystem, sensors, event log.
export const W = {
  now: 1763127125000, timers: [], seq: 0, files: new Map(), log: [], buzz: [], exited: false, replaced: null,
  keyCb: null, geo: null, screen: null, storage: new Map(), widgets: [], recorderBytes: null, request: null
}
Date.now = () => W.now
export function advance(ms) {
  const end = W.now + ms
  for (;;) {
    W.timers.sort((a, b) => a.at - b.at || a.id - b.id)
    const t = W.timers[0]
    if (!t || t.at > end) break
    W.timers.shift()
    W.now = t.at
    if (t.every) { t.at += t.every; W.timers.push(t) }
    t.fn()
  }
  W.now = end
}
