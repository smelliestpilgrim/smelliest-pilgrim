// Memo Send page. Reached by clicking any button in the first 2 s after
// launch (before anything records). No mic or GPS runs on this page.
//   SEND ALL (or SELECT click) -> every unsent memo, then the log, to WatchMemo
//   GPS button      -> cycles GPS: ON -> GPS+sats -> GPS: OFF (stored)
//                      OFF = safe mode, no Geolocation at all
//                      GPS+sats = also read satellites used (onGnssChange)
//   Screen: ON/OFF  -> stored; for test T2
//   Chunk 10K       -> cycles chunk size 2K -> 5K -> 10K -> 16K (stored, 0.1.4);
//                      a size that keeps failing drops by itself mid-send
//   Log             -> view the breadcrumb log (and send it from there)
//   Clear sent      -> tap twice; deletes only phone-confirmed memos
import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'
import { push } from '@zos/router'
import { Vibrator, VIBRATOR_SCENE_STRONG_REMINDER, VIBRATOR_SCENE_DURATION_LONG, VIBRATOR_SCENE_SHORT_STRONG } from '@zos/sensor'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { onKey, offKey, KEY_SELECT, KEY_EVENT_CLICK } from '@zos/interaction'
import { setTimeout, clearTimeout } from '@zos/timer'
import { localStorage } from '@zos/storage'
import { connectStatus } from '@zos/ble'
import { BasePage } from '@zeppos/zml/base-page'
import { listMemos, readAudio, markSent, clearConfirmedSent, ensureDir } from '../utils/store'
import { sendAll, sendText, requestWithTimeout, linkHint, linkKind } from '../utils/sender'
import { PING_TIMEOUT_MS, CHUNK_SIZES, DEFAULT_CHUNK, chunkLabel } from '../utils/protocol'
import { blog, logBytes } from '../utils/blog'

const VERSION = '0.3.2' // local const only: page files must never export
const WHITE = 0xffffff
const GREY = 0xb0b0b0
const BTN = 0x1f5fbf
const BTN_PRESS = 0x0f3f8f
const BTN2 = 0x3a3a3a
const BTN2_PRESS = 0x222222

function kb(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'
}

Page(
  BasePage({
    state: {},

    build() {
      blog('send page open v' + VERSION)
      this.dead = false
      this.vib = null
      try { this.vib = new Vibrator() } catch (e) {}
      this.busy = false
      this.armClear = 0
      this.timers = []
      this.memos = []
      ensureDir()
      try { setPageBrightTime({ brightTime: 600000 }) } catch (e) {}
      try { pauseDropWristScreenOff({ duration: 0 }) } catch (e) {}
      const W = 480
      const btn = (x, y, w, h, color, press, size, text, fn) =>
        hmUI.createWidget(hmUI.widget.BUTTON, {
          x: px(x), y: px(y), w: px(w), h: px(h), radius: px(Math.floor(h / 2)),
          normal_color: color, press_color: press, color: WHITE, text_size: px(size), text, click_func: fn
        })
      const txt = (y, h, size, color, text) =>
        hmUI.createWidget(hmUI.widget.TEXT, {
          x: px(40), y: px(y), w: px(W - 80), h: px(h), color, text_size: px(size),
          align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.WRAP, text
        })

      this.wGpsBtn = btn(96, 52, 140, 50, BTN2, BTN2_PRESS, 22, this.gpsLabel(), () => this.cycleGps())
      this.wKeep = btn(244, 52, 140, 50, BTN2, BTN2_PRESS, 22, this.keepLabel(), () => this.toggle('keepOn', this.wKeep, () => this.keepLabel()))
      this.wCount = txt(112, 66, 42, WHITE, '')
      this.wPhone = txt(178, 66, 26, GREY, 'checking phone app...')
      this.wSend = btn(80, 244, 320, 74, BTN, BTN_PRESS, 38, 'SEND ALL', () => this.startSend())
      this.wStatus = txt(320, 60, 24, WHITE, 'phone: open Smelliest Pilgrim first')
      // bottom row: three buttons inside the round screen (y 382..428)
      this.wLog = btn(92, 382, 92, 46, BTN2, BTN2_PRESS, 22, 'Log', () => this.openLog())
      this.wChunk = btn(190, 382, 100, 46, BTN2, BTN2_PRESS, 20, this.chunkText(), () => this.cycleChunk())
      this.wClear = btn(296, 382, 92, 46, BTN2, BTN2_PRESS, 18, 'Clear sent', () => this.clearSent())

      try {
        onKey({
          callback: (key, ev) => {
            if (key === KEY_SELECT && ev === KEY_EVENT_CLICK) {
              this.later(() => this.startSend(), 0)
              return true
            }
            return false
          }
        })
      } catch (e) {}

      this.refresh()
      this.ping()
    },

    later(fn, ms) {
      const t = setTimeout(() => {
        this.timers = this.timers.filter((x) => x !== t)
        if (this.dead) return
        try { fn() } catch (e) { blog('menu timer err ' + e) }
      }, ms)
      this.timers.push(t)
      return t
    },

    set(w, text, color) {
      try {
        const o = { text }
        if (color !== undefined) o.color = color
        w.setProperty(hmUI.prop.MORE, o)
      } catch (e) {}
    },

    buzz(mode) {
      if (!this.vib) return
      try { this.vib.stop() } catch (e) {}
      try { this.vib.setMode(mode); this.vib.start() } catch (e) {}
    },

    on(key) {
      try { return localStorage.getItem(key, '1') !== '0' } catch (e) { return true }
    },
    gpsLabel() {
      if (!this.on('gpsOn')) return 'GPS: OFF'
      return this.satsOn() ? 'GPS+sats' : 'GPS: ON'
    },
    satsOn() {
      try { return localStorage.getItem('satsOn', '0') === '1' } catch (e) { return false }
    },
    // GPS: ON -> GPS+sats -> GPS: OFF -> GPS: ON (single taps only)
    cycleGps() {
      try {
        if (!this.on('gpsOn')) { localStorage.setItem('gpsOn', '1'); localStorage.setItem('satsOn', '0') }
        else if (!this.satsOn()) localStorage.setItem('satsOn', '1')
        else { localStorage.setItem('gpsOn', '0'); localStorage.setItem('satsOn', '0') }
      } catch (e) {}
      this.set(this.wGpsBtn, this.gpsLabel())
      blog('setting gps=' + this.on('gpsOn') + ' sats=' + this.satsOn())
    },
    // 0.1.4 chunk size, single taps: 2K -> 5K -> 10K -> 16K -> 2K
    chunkBytes() {
      let v = DEFAULT_CHUNK
      try { v = Number(localStorage.getItem('chunkB', String(DEFAULT_CHUNK))) } catch (e) {}
      return CHUNK_SIZES.indexOf(v) >= 0 ? v : DEFAULT_CHUNK
    },
    chunkText() { return 'Chunk ' + chunkLabel(this.chunkBytes()) },
    cycleChunk() {
      if (this.busy) return
      const k = CHUNK_SIZES.indexOf(this.chunkBytes())
      const v = CHUNK_SIZES[(k + 1) % CHUNK_SIZES.length]
      try { localStorage.setItem('chunkB', String(v)) } catch (e) {}
      this.set(this.wChunk, this.chunkText())
      this.set(this.wStatus, 'chunk size ' + chunkLabel(v) + (v === 2048 ? ' (0.1.3 size, safest)' : v === 16384 ? ' (test, may drop)' : ''), WHITE)
      blog('setting chunk=' + chunkLabel(v))
    },
    keepLabel() { return 'Screen: ' + (this.on('keepOn') ? 'ON' : 'OFF') },
    toggle(key, w, label) {
      try { localStorage.setItem(key, this.on(key) ? '0' : '1') } catch (e) {}
      this.set(w, label())
      blog('setting ' + key + '=' + this.on(key))
    },

    refresh() {
      let all = []
      try { all = listMemos() } catch (e) { blog('list err ' + e) }
      this.memos = all
      const unsent = all.filter((m) => !m.sent && m.bytes > 0)
      const sent = all.filter((m) => m.sent)
      const bytes = unsent.reduce((s, m) => s + m.bytes, 0)
      this.set(this.wCount, unsent.length ? unsent.length + ' to send, ' + kb(bytes) : 'nothing to send')
      this.set(this.wClear, 'Clear ' + sent.length)
      return unsent.length
    },

    ping() {
      requestWithTimeout(this.io(), { method: 'ping', params: {} }, PING_TIMEOUT_MS, (err, r) => {
        if (!err && r && r.ok) {
          this.phoneOk = true
          this.offsets = !!r.offsets // WatchMemo 0.2.2+: chunks by byte offset
          blog('ping ok app=' + (r.ver || 'pre-0.2.2') + ' offsets=' + this.offsets)
          this.set(this.wPhone, (r.dest === 'server' ? 'server' : 'phone app') + ' ready (' + (r.today || 0) + ' today)', WHITE)
        }
        else this.set(this.wPhone, (r && r.dest === 'server' ? 'server: ' : 'phone app: ') + (err || (r && r.error) || 'no answer'), GREY)
      })
    },

    io() {
      return {
        chunkBytes: this.chunkBytes(),
        offsets: !!this.offsets,
        phoneOk: !!this.phoneOk,
        readChunk: (memo, off, len) => readAudio(memo.id, off, len),
        request: (d) => this.request(d),
        // tracked, so leaving the page cancels pending retries
        setTimeout: (fn, ms) => this.later(fn, ms),
        clearTimeout: (t) => { try { clearTimeout(t) } catch (e) {} this.timers = this.timers.filter((x) => x !== t) },
        markSent: (memo, reply) => markSent(memo, reply),
        now: () => Date.now(),
        linkUp: () => connectStatus(),
        log: (line) => blog(line),
        alive: () => !this.dead,
        loadResume: (id) => {
          try {
            const v = localStorage.getItem('resume', '')
            const o = v ? JSON.parse(v) : null
            return o && o.id === id ? o : null
          } catch (e) { return null }
        },
        saveResume: (id, o) => {
          try { localStorage.setItem('resume', o ? JSON.stringify(Object.assign({ id }, o)) : '') } catch (e) {}
        }
      }
    },

    // Shown while a chunk waits to be retried. One buzz per send run the
    // first time the phone side needs attention.
    showRetry(e, prefix) {
      const hint = linkHint(e.kind)
      this.set(this.wPhone, hint, WHITE)
      this.set(this.wStatus, prefix + 'retrying in ' + Math.round(e.delay / 1000) + ' s (try ' + (e.tries + 1) + ')', WHITE)
      if (!this.warned) {
        this.warned = true
        this.buzz(VIBRATOR_SCENE_SHORT_STRONG)
      }
    },

    sendLogAfter(summary, failed) {
      this.set(this.wStatus, summary + ' Sending log...', WHITE)
      sendText(this.io(), logBytes(), null, (err, r) => {
        if (this.dead) return
        this.busy = false
        this.set(this.wSend, 'SEND ALL')
        this.set(this.wStatus, summary + (err ? ' Log not sent.' : ' Log sent.'), WHITE)
        if (err) blog('log send err ' + err)
        this.buzz(failed ? VIBRATOR_SCENE_DURATION_LONG : VIBRATOR_SCENE_STRONG_REMINDER)
      }, (e) => this.showRetry(e, 'log: '))
    },

    startSend() {
      if (this.busy) return
      this.busy = true
      this.shownChunk = 0
      this.warned = false
      this.pct = ''
      this.set(this.wSend, 'SENDING')
      this.buzz(VIBRATOR_SCENE_SHORT_STRONG)
      const n = this.refresh()
      blog('send all: ' + n + ' memos')
      if (n === 0) return this.sendLogAfter('No memos.', false)
      sendAll(this.io(), this.memos, (e) => {
        if (e.type === 'memo') {
          this.set(this.wStatus, 'memo ' + e.index + ' of ' + e.total)
        } else if (e.type === 'progress') {
          const pct = Math.floor((e.bytes / e.size) * 100)
          if (this.warned && this.retrying) this.set(this.wPhone, 'sending again', WHITE)
          this.retrying = false
          this.pct = pct + '% '
          this.set(this.wStatus, 'memo ' + e.index + ' of ' + e.total + ': ' + pct + '%  ' + e.kbps.toFixed(1) + ' KB/s ' + chunkLabel(e.chunk))
          if (e.chunk !== this.shownChunk) { this.shownChunk = e.chunk; this.set(this.wChunk, 'Now ' + chunkLabel(e.chunk)) }
        } else if (e.type === 'retry') {
          this.retrying = true
          this.showRetry(e, 'memo ' + e.index + '/' + e.total + ' ' + (this.pct || '') + '- ')
        } else if (e.type === 'sent') {
          this.set(this.wPhone, 'last saved as ' + (e.reply.file || '?'), WHITE)
        } else if (e.type === 'failed') {
          blog('memo ' + e.memo.id + ' failed: ' + e.error)
          this.set(this.wPhone, 'memo ' + e.index + ' failed: ' + e.error, GREY)
        } else if (e.type === 'done') {
          this.refresh()
          this.set(this.wChunk, this.chunkText())
          const sizes = chunkLabel(e.chunkStart) + (e.chunkEnd !== e.chunkStart ? '->' + chunkLabel(e.chunkEnd) : '')
          blog('send done ok=' + e.ok + ' failed=' + e.failed + ' retries=' + e.retries + ' ' + e.kbps.toFixed(2) + 'KB/s overall, ' + (e.memoKbps || 0).toFixed(2) + 'KB/s per memo, chunk ' + sizes + (e.offsets ? ' offsets' : ' index') + ', ' + Math.round(e.secs) + 's')
          e.drops.forEach((d) => blog('  dropped ' + chunkLabel(d.from) + '->' + chunkLabel(d.to) + ' on memo ' + d.memo + ' at byte ' + d.at + ': ' + d.why))
          const speed = e.kbps.toFixed(1) + ' KB/s @' + sizes + ', ' + Math.round(e.secs) + ' s.'
          if (e.failed === 0) this.sendLogAfter('ALL ' + e.ok + ' SENT OK. ' + speed, false)
          else {
            this.set(this.wPhone, String(e.lastErr).slice(0, 90), GREY)
            const left = e.total - e.ok
            if (e.linkDead) {
              // Link gone for minutes: the log would only fail too.
              this.busy = false
              this.set(this.wSend, 'SEND ALL')
              const k = linkKind(e.lastErr)
              const fix = k === 'phone' ? 'Open Smelliest Pilgrim on phone' : k === 'server' ? 'Check phone internet / app settings' : k === 'ble' ? 'Reconnect watch to phone' : 'Check Zepp app on phone'
              this.set(this.wStatus, e.ok + ' sent, ' + left + ' left. ' + fix + ', then SEND.', WHITE)
              this.set(this.wPhone, 'gave up: ' + String(e.lastErr).slice(0, 60), GREY)
              this.buzz(VIBRATOR_SCENE_DURATION_LONG)
            } else this.sendLogAfter(e.ok + ' sent, ' + e.failed + ' NOT sent.', true)
          }
        }
      })
    },

    openLog() {
      if (this.busy) return
      push({ url: 'page/log' })
    },

    clearSent() {
      if (this.busy) return
      const now = Date.now()
      if (now - this.armClear > 4000) {
        this.armClear = now
        this.set(this.wClear, 'Sure? tap')
        this.later(() => this.refresh(), 4000)
        return
      }
      this.armClear = 0
      const n = clearConfirmedSent()
      blog('cleared ' + n)
      this.refresh()
      this.set(this.wStatus, 'deleted ' + n + ' sent memos from watch')
    },

    onDestroy() {
      this.dead = true
      this.timers.forEach((t) => { try { clearTimeout(t) } catch (e) {} })
      try { offKey() } catch (e) {}
      try { resetDropWristScreenOff() } catch (e) {}
      try { resetPageBrightTime() } catch (e) {}
      if (this.vib) { try { this.vib.stop() } catch (e) {} }
    }
  })
)
