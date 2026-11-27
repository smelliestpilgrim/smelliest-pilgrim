import { W } from './env.mjs'
export const widget = { TEXT: 'TEXT', BUTTON: 'BUTTON', ARC: 'ARC' }
export const align = { CENTER_H: 1, CENTER_V: 2, LEFT: 3, TOP: 4 }
export const text_style = { WRAP: 1 }
export const prop = { MORE: 'MORE', TEXT: 'text', VISIBLE: 'visible' }
export function createWidget(type, p) {
  W.creates = (W.creates || 0) + 1
  if (W.failCreateAt && W.creates === W.failCreateAt) throw new Error('widget rejected (test)')
  const w = { type, p: { ...p, visible: true }, setProperty(k, v) { W.sets = (W.sets || 0) + 1; if (k === 'MORE') Object.assign(this.p, v); else this.p[k] = v } }
  W.widgets.push(w)
  return w
}
