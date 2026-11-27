// Runs the REAL zeus-built page bundles (captured qjsc input) in a vm sandbox
// that mimics the watch: no `exports`, no `require`, @zos modules via __$$R$$__.
// Catches errors that only exist after bundling (e.g. the 0.1.1 `exports` bug).
import vm from 'node:vm'
import fs from 'node:fs'
const dir = process.argv[2]
const mods = {}
for (const m of ['ui', 'utils', 'router', 'media', 'sensor', 'display', 'interaction', 'timer', 'storage', 'fs'])
  mods['@zos/' + m] = await import('../sim/mock/' + m + '.mjs')
const { W, advance } = await import('../sim/mock/env.mjs')
Object.assign(W, { timers: [], log: [], buzz: [], widgets: [], violations: [] })
const LOGGER = { getLogger: () => ({ log() {}, info() {}, warn() {}, error() {}, debug() {} }) }
mods['@zos/utils'] = { ...mods['@zos/utils'], log: LOGGER, EventBus: class { on() {} off() {} emit() {} } }
mods['@zos/device'] = { getDeviceInfo: () => ({ width: 480, height: 480, screenShape: 1 }) }
mods['@zos/app'] = {}
mods['@zos/i18n'] = { getText: (s) => s }
mods['@zos/ble'] = { addListener() {}, removeListener() {}, send() {}, connectStatus: () => true, TransferFile: class {} }
const box = { on() {}, off() {}, getNextFile() { return null }, enqueueFile() {} }
mods['@zos/ble/TransferFile'] = function TransferFile() { this.getInbox = () => box; this.getOutbox = () => box }
let fail = 0
for (const name of ['index', 'menu', 'log']) {
  const code = fs.readFileSync(dir + '/' + name + '.js', 'utf8')
  let page = null
  const logs = []
  const g = {
    __$$G$$__: null,
    console: { log: (...a) => logs.push(a.join(' ')) },
    DeviceRuntimeCore: { LifeCycle: {}, HmLogger: { getLogger: () => ({ log() {}, info() {}, warn() {}, error() {}, debug() {} }) } },
    __$$R$$__: (id) => { if (!mods[id]) throw new Error('no module ' + id); return mods[id] },
    __$$module$$__: {},
    Page: (o) => { page = o; return o },
    App: () => {}, getApp: () => ({ _options: { globalData: {} } }), getCurrentPage: () => page,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Object, Array, String, Number,
    Uint8Array, ArrayBuffer, DataView, Error, Symbol, Promise, Buffer, TextEncoder, TextDecoder, isFinite, encodeURIComponent
  }
  g.__$$G$$__ = g
  g.__$$hmAppManager$$__ = { currentApp: { current: { __globals__: { __$$G$$__: g } } } }
  vm.createContext(g)
  try { vm.runInContext(code, g, { filename: name + '.js' }) } catch (e) { logs.push('THROW ' + e) }
  const err = logs.find((l) => /Mini Program Error|THROW/.test(l))
  if (err || !page) { fail++; console.log('  FAIL', name, err || 'Page() never registered', logs.slice(0, 3)) }
  else {
    try { page.build && page.build.call(page); console.log('  ok', name, 'bundle loads, Page() registered, build() ran; widgets:', W.widgets.length) }
    catch (e) { fail++; console.log('  FAIL', name, 'build threw', e) }
  }
}
if (fail) process.exit(1)
console.log('BUNDLE PASS')
