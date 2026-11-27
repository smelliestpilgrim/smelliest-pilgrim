// The memo page. Holds no data itself: everything comes from /api/* with the
// token, and each recording is turned into a standard .ogg in this browser.
import { zeppToOgg } from './opus.js'

const $ = (id) => document.getElementById(id)
const KEY = 'watchmemo.token'
let token = sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''
const urls = []

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }, opts || {}))
  if (r.status === 401) { showLogin('That token was refused.'); throw new Error('bad token') }
  return r
}
async function json(path, opts) {
  const r = await api(path, opts)
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

function showLogin(msg) {
  $('app').hidden = true
  $('login').hidden = false
  $('loginErr').textContent = msg || ''
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  token = $('token').value.trim()
  sessionStorage.setItem(KEY, token)
  if ($('remember').checked) localStorage.setItem(KEY, token)
  else localStorage.removeItem(KEY)
  $('token').value = ''
  start()
})
$('logout').addEventListener('click', () => {
  sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); token = ''
  showLogin('')
})

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'onclick') e.addEventListener('click', v)
    else if (k === 'text') e.textContent = v
    else e.setAttribute(k, v)
  }
  for (const k of kids) if (k != null) e.append(k)
  return e
}
const dur = (ms) => (ms < 0 || ms == null ? '?' : Math.floor(Math.round(ms / 1000) / 60) + ':' + String(Math.round(ms / 1000) % 60).padStart(2, '0'))

async function start() {
  if (!token) return showLogin('')
  let days
  try { days = (await json('/api/days')).days } catch (e) { if (e.message !== 'bad token') showLogin(e.message); return }
  $('login').hidden = true
  $('app').hidden = false
  const box = $('days')
  box.replaceChildren()
  if (!days.length) { $('memos').textContent = 'No memos yet. Send some from the watch.'; return }
  for (const d of days) {
    box.append(el('button', { type: 'button', 'data-day': d.day, onclick: () => showDay(d.day) }, d.day + ' (' + d.n + ')'))
  }
  showDay(days[0].day)
}

async function showDay(day) {
  for (const b of $('days').children) b.classList.toggle('on', b.getAttribute('data-day') === day)
  while (urls.length) URL.revokeObjectURL(urls.pop())
  const list = $('memos')
  list.replaceChildren('Loading...')
  const { memos } = await json('/api/memos?day=' + day)
  list.replaceChildren()
  const fixes = memos.filter((m) => m.meta.fix).length
  $('dayInfo').textContent = memos.length + ' memo' + (memos.length === 1 ? '' : 's') + ', ' + fixes + ' with GPS. Times are the watch\u2019s local time.'
  for (const m of memos) list.append(memoRow(m))
  const { logs } = await json('/api/logs?day=' + day)
  const lb = $('logs')
  lb.replaceChildren()
  if (logs.length) {
    lb.append('Watch logs: ')
    for (const l of logs) {
      const name = l.name.split('/')[1]
      lb.append(el('button', { type: 'button', onclick: () => download('/api/log/' + l.name, name, 'text/plain') }, name), ' ')
    }
  }
}

function memoRow(m) {
  const meta = m.meta
  const gps = meta.fix && meta.lat != null
    ? el('a', { href: 'https://maps.google.com/?q=' + meta.lat.toFixed(6) + ',' + meta.lon.toFixed(6), target: '_blank', rel: 'noopener noreferrer' }, meta.lat.toFixed(6) + ', ' + meta.lon.toFixed(6))
    : el('span', { class: 'muted' }, 'no GPS fix')
  const status = el('span', { class: 'muted' }, '')
  const player = el('div')
  const row = el('div', { class: 'memo' },
    el('div', { class: 'row' }, el('span', { class: 'time' }, m.time), el('span', { class: 'muted' }, dur(meta.watchAudioMs) + ' \u00b7 ' + (m.size / 1024).toFixed(1) + ' KB')),
    el('div', { class: 'row' }, gps, meta.note ? el('span', { class: 'muted' }, '\u00b7 ' + meta.note) : null),
    el('div', { class: 'row', style: 'margin-top:6px' },
      el('button', { type: 'button', class: 'primary', onclick: () => play(m, player, status) }, 'Play'),
      el('button', { type: 'button', onclick: () => save(m, status) }, 'Download .ogg'),
      el('button', { type: 'button', class: 'danger', onclick: () => del(m, row) }, 'Delete'),
      status),
    player)
  return row
}

const cache = new Map()
async function ogg(m, status) {
  if (cache.has(m.id)) return cache.get(m.id)
  status.textContent = 'fetching...'
  const r = await api('/api/memo/' + m.id + '/raw')
  if (!r.ok) throw new Error((await r.json()).error)
  const raw = new Uint8Array(await r.arrayBuffer())
  if (raw.length !== m.size) throw new Error('got ' + raw.length + ' bytes, expected ' + m.size)
  const { ogg, parsed } = zeppToOgg(raw, m.id, m.day + ' ' + m.time)
  const blob = new Blob([ogg], { type: 'audio/ogg; codecs=opus' })
  const url = URL.createObjectURL(blob)
  urls.push(url)
  const out = { url, parsed }
  cache.set(m.id, out)
  status.textContent = dur(parsed.durationMs) + (parsed.truncated ? ' (recording was cut short)' : '')
  return out
}

async function play(m, player, status) {
  try {
    const { url } = await ogg(m, status)
    const a = el('audio', { controls: '', src: url })
    player.replaceChildren(a)
    a.play().catch(() => {})
  } catch (e) { status.textContent = 'error: ' + e.message }
}

async function save(m, status) {
  try {
    const { url } = await ogg(m, status)
    const a = el('a', { href: url, download: m.day + '_' + m.file })
    document.body.append(a); a.click(); a.remove()
  } catch (e) { status.textContent = 'error: ' + e.message }
}

async function download(path, name, type) {
  const r = await api(path)
  const url = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }))
  const a = el('a', { href: url, download: name })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

async function del(m, row) {
  if (!confirm('Delete the ' + m.time + ' memo from the server? This cannot be undone.')) return
  await json('/api/memo/' + m.id, { method: 'DELETE' })
  row.remove()
}

start()
