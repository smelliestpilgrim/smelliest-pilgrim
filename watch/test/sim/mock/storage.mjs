import { W } from './env.mjs'
export const localStorage = {
  getItem: (k, d) => (W.storage.has(k) ? W.storage.get(k) : d),
  setItem: (k, v) => W.storage.set(k, v)
}
