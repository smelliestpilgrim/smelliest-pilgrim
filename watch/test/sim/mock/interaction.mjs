import { W } from './env.mjs'
export const KEY_BACK = 8, KEY_SELECT = 13, KEY_HOME = 36, KEY_UP = 38, KEY_DOWN = 40, KEY_SHORTCUT = 41
export const KEY_EVENT_CLICK = 1, KEY_EVENT_LONG_PRESS = 2, KEY_EVENT_DOUBLE_CLICK = 3, KEY_EVENT_PRESS = 4, KEY_EVENT_RELEASE = 5
export function onKey(o) { W.keyCb = o.callback || o }
export function offKey() { W.keyCb = null }
