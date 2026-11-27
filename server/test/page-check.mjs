// Drives the memo page in headless Chrome (plain CDP, no extra packages):
// log in with the token, list the day, press Play, wait for the audio to load,
// and save a screenshot. usage: node test/page-check.mjs <out.png>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const OUT = process.argv[2]
const BASE = process.env.SERVER || 'http://127.0.0.1:8787'
const port = 9333
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/wm-chrome', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let tabs
for (let i = 0; i < 50 && !tabs; i++) { await sleep(200); try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch (e) {} }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0; const waits = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id) } })
const send = (method, params) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value
await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: BASE + '/' }); await sleep(1500)
const loginShown = await ev(`!document.getElementById('login').hidden`)
await ev(`document.getElementById('token').value = 'wrong-token-wrong-token'; document.querySelector('#loginForm button').click(); 1`); await sleep(800)
const refused = await ev(`document.getElementById('loginErr').textContent`)
await ev(`document.getElementById('token').value = ${JSON.stringify(process.env.TOKEN)}; document.querySelector('#loginForm button').click(); 1`); await sleep(1500)
const memoCount = await ev(`document.querySelectorAll('.memo').length`)
const gpsLink = await ev(`[...document.querySelectorAll('.memo a')].map(a => a.href).join(' ')`)
await ev(`document.querySelectorAll('.memo')[4].querySelector('button.primary').click(); 1`)
const duration = await ev(`new Promise(res => { const t0 = Date.now(); (function w(){ const a = document.querySelector('audio'); if (a && a.readyState >= 1 && isFinite(a.duration)) return res(a.duration); if (Date.now() - t0 > 8000) return res(-1); setTimeout(w, 100) })() })`)
const played = await ev(`new Promise(res => { const t0 = Date.now(); (function w(){ const a = document.querySelector('audio'); if (a.currentTime > 0.3 || Date.now() - t0 > 6000) return res(a.currentTime); setTimeout(w, 100) })() })`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log(JSON.stringify({ loginShown, refused, memoCount, gpsLink, duration, played }))
ws.close(); chrome.kill()
if (!(loginShown && /refused/.test(refused) && memoCount >= 5 && /maps\.google\.com\/\?q=-?\d+\.\d{6},-?\d+\.\d{6}/.test(gpsLink) && duration > 1 && played > 0.3)) { console.log('PAGE CHECK FAILED'); process.exit(1) }
console.log('PAGE CHECK PASSED')
