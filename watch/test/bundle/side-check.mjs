// Runs the BUILT app-side.js and setting.js (from the .zab) in a sandbox with
// mocked Zepp phone globals: a ping relayed to "My server", the token header,
// the default phone route, and the Settings "Test connection" round trip.
// usage: node side-check.mjs <dir with app-side.js and setting.js>
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const dir = process.argv[2]
const store = {}
const listeners = []
const calls = []
let svc = null
const anyObj = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : anyObj()), apply: () => anyObj() })
const ctx = {
  console, setTimeout, clearTimeout, URL, Buffer, Promise, JSON, Date,
  AppSideService: (o) => { svc = o },
  Logger: { getLogger: () => ({ log() {}, info() {}, warn() {}, error() {}, debug() {} }) },
  sideService: { appInfo: { app: { appName: 'Smelliest Pilgrim' } }, launchReasons: {}, launchArgs: {} },
  settings: { settingsStorage: {
    getItem: (k) => store[k], setItem: (k, v) => { store[k] = v; listeners.forEach((l) => l({ key: k, newValue: v })) },
    addListener: (ev, fn) => listeners.push(fn), removeListener() {}, toObject: () => ({ ...store }), clear() {}, removeItem() {}
  } },
  messaging: { peerSocket: { addListener() {}, removeListener() {}, send() {}, readyState: 1 } },
  transferFile: { inbox: { on() {}, getNextFile() {} }, outbox: { enqueueFile() {} }, getInbox: () => ({ on() {} }), getOutbox: () => ({}) },
  network: anyObj(), image: anyObj(), getApp: () => anyObj(),
  fetch: (o) => { calls.push(o); return Promise.resolve({ status: 200, body: JSON.stringify({ ok: true, today: 3, offsets: true }) }) }
}
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(dir + '/app-side.js', 'utf8'), ctx, { filename: 'app-side.js' })
assert.ok(svc, 'AppSideService registered')
svc.onInit && svc.onInit()
const ask = (req) => new Promise((res) => svc.__onRequest(req, (e, r) => res(r)))
let r = await ask({ method: 'ping', params: {} })
assert.equal(calls.at(-1).url, 'http://127.0.0.1:8765/ping'); assert.ok(!calls.at(-1).headers || !calls.at(-1).headers.Authorization)
assert.equal(r.dest, 'phone')
console.log('  ok built Side Service, no settings: ping -> http://127.0.0.1:8765/ping, no token header')
store.dest = 'server'; store.serverUrl = 'https://watchmemo.example.workers.dev/'; store.serverToken = 'tok-abc'
r = await ask({ method: 'chunk', params: { id: 1, i: 0, n: 1, o: 0, d: 'AAAA' } })
assert.equal(calls.at(-1).url, 'https://watchmemo.example.workers.dev/chunk?id=1&i=0&n=1&o=0')
assert.equal(calls.at(-1).headers.Authorization, 'Bearer tok-abc'); assert.equal(r.dest, 'server')
console.log('  ok My server: chunk -> https://.../chunk?...&o=0 with "Authorization: Bearer <token>"')
store.serverUrl = 'http://evil.example'
r = await ask({ method: 'ping', params: {} })
assert.equal(r.ok, false); assert.match(r.error, /https/)
console.log('  ok non-https internet URL refused without any fetch: ' + r.error)
store.serverUrl = 'https://watchmemo.example.workers.dev'
ctx.settings.settingsStorage.setItem('testReq', String(Date.now()))
await new Promise((res) => setTimeout(res, 50))
assert.match(store.testResult, /^OK: server answered \(3 memos today\) at \d\d:\d\d$/)
console.log('  ok Test connection from Settings: testResult = "' + store.testResult + '"')
// setting.js must define the page with the real globals only
let page
const sctx = { AppSettingsPage: (p) => { page = p } }
for (const n of ['Section', 'View', 'Text', 'Select', 'TextInput', 'Button', 'Link']) sctx[n] = (p, k) => ({ n, p, k })
vm.createContext(sctx)
vm.runInContext(fs.readFileSync(dir + '/setting.js', 'utf8'), sctx, { filename: 'setting.js' })
assert.ok(page && page.build({ settingsStorage: { getItem: (k) => store[k], setItem() {} } }))
console.log('  ok built setting.js renders')
console.log('BUILT SIDE SERVICE + SETTINGS PASS')
