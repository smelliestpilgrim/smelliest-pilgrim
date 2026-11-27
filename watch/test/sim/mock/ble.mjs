import { W } from './env.mjs'
export function connectStatus() { W.linkChecks = (W.linkChecks || 0) + 1; return W.linkUp !== false }
