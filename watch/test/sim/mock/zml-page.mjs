import { W } from './env.mjs'
export function BasePage(o) { o.request = (d) => W.request(d); return o }
