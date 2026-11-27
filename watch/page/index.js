// Memo 0.1.4 (record page unchanged since 0.1.3): record page, rebuilt defensively after two watch reboots.
//
//   launch            -> "press a button or tap SEND" for PRESTART_MS (2 s).
//                        Nothing is running yet: a single click, or a tap on
//                        the SEND touch button, opens the Send page cleanly.
//                        Otherwise recording starts.
//   rec start         -> long buzz; mic + GPS on (GPS only if enabled)
//   click any button  -> recording stops (two short buzzes), memo .json
//                        written at once ("fix pending"), one size check
//                        STAT_DELAY_MS later.
//   fix already/later -> four quick buzzes, everything stopped, app exits.
//   no fix after GPS_WAIT_AFTER_STOP_MS -> saved as "no fix", long buzz, exit.
//   single UP click while waiting for GPS -> give up, saved as "no fix", exit.
//   No long presses anywhere: they are left to the watch's own shortcuts.
//
// Rules this file now follows (hypothesis: the reboots came from native
// calls at the wrong moment, see FIX-0.1.1.md):
//   - never reads the audio file on the watch (no read right after stop)
//   - never leaves the page while the mic or GPS is on: cleanup() first
//   - one Geolocation, start() once, onChange() once; the callback only
//     copies values; offChange()+stop() exactly once, never from inside it
//   - no getter polling, no ARC widget recolouring
//   - onGnssChange only when the user chose "GPS+sats" on the Send page
//     (0.1.3, opt-in: it was on the suspect list for the 0.1.0 reboots);
//     its callback copies one number, offGnssChange happens with offChange
//   - recorder.stop() exactly once; nothing touches the recorder after it
//   - widgets only via setProperty, only when the text changes, <= 1/s
//   - breadcrumbs in data://memo_log.txt at every stage
import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'
import { exit, replace } from '@zos/router'
import { create, id as mediaId, codec } from '@zos/media'
import { Vibrator, Geolocation, Screen, VIBRATOR_SCENE_DURATION, VIBRATOR_SCENE_DURATION_LONG, VIBRATOR_SCENE_NOTIFICATION, VIBRATOR_SCENE_STRONG_REMINDER } from '@zos/sensor'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { onKey, offKey, KEY_SELECT, KEY_UP, KEY_DOWN, KEY_BACK, KEY_EVENT_CLICK } from '@zos/interaction'
import { setTimeout, clearTimeout, setInterval, clearInterval } from '@zos/timer'
import { localStorage } from '@zos/storage'
import { BasePage } from '@zeppos/zml/base-page'
import { ensureDir, recorderTarget, audioSize, saveMeta } from '../utils/store'
import { fmtDur } from '../utils/codec'
import { blog } from '../utils/blog'

// NOTE: never `export` anything from a page file. The bundler then emits
// `exports.X = ...`, and `exports` does not exist on the watch: the page dies
// before Page() registers (0.1.1 black-screen bug).
const VERSION = '0.2.1'

// ---- tunables ------------------------------------------------------------
const PRESTART_MS = 2000 // window to press a button for the Send page
const KEY_GUARD_MS = 400 // ignore keys this soon after launch (the launch press)
const GPS_WAIT_AFTER_STOP_MS = 3 * 60 * 1000 // give up on GPS this long after stop
const MAX_RECORD_MS = 10 * 60 * 1000 // auto-stop a forgotten recording
const STAT_DELAY_MS = 600 // one size check this long after recorder.stop()
const STAT_RETRY_MS = 2000 // one more check if the first saw 0 bytes
const EXIT_DELAY_MS = 2000 // let the last buzz (1.2 s) finish before exit
// SAFE MODE: if GPS turns out to be the culprit, set GPS off on the Send page
// (stored setting), or flip this default. Off = no Geolocation at all, no wait.
const GPS_DEFAULT_ON = true

const WHITE = 0xffffff
const GREY = 0xb0b0b0

const KEYNAME = {}
KEYNAME[KEY_SELECT] = 'SEL'
KEYNAME[KEY_UP] = 'UP'
KEYNAME[KEY_DOWN] = 'DOWN'
KEYNAME[KEY_BACK] = 'BACK'

Page(
  BasePage({
    state: {},

    build() {
      // 1. Something visible before anything else can go wrong.
      try {
        this.wBoot = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 40, y: 380, w: 400, h: 50, color: 0xffffff, text_size: 28,
          align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V, text: 'Smelliest Pilgrim ' + VERSION + ' starting'
        })
      } catch (e) {}
      try {
        this.buildInner()
        try { this.wBoot.setProperty(hmUI.prop.MORE, { text: '' }) } catch (e) {}
      } catch (e) {
        this.fatal('build', e)
      }
    },

    // Any startup error: big white text on screen + log, never a black page.
    fatal(where, e) {
      const msg = where + ': ' + (e && e.message ? e.message : String(e))
      try { blog('FATAL ' + msg) } catch (e2) {}
      try {
        hmUI.createWidget(hmUI.widget.TEXT, {
          x: 30, y: 120, w: 420, h: 300, color: 0xffffff, text_size: 32,
          align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.WRAP,
          text: 'Smelliest Pilgrim ' + VERSION + ' error\n' + msg.slice(0, 120) + '\nBACK to exit'
        })
      } catch (e3) {}
      try { if (this.s) this.cleanup('fatal') } catch (e4) {}
    },

    buildInner() {
      const now = Date.now()
      const s = (this.s = {
        t0: now,
        id: 0,
        phase: 'prestart', // prestart|recording|stopping|gps|done|failed|menu
        recStarted: 0,
        recStopped: 0,
        recStopDone: false,
        fix: false,
        lat: null,
        lon: null,
        fixMs: null,
        geoChanges: 0,
        geoStopped: true,
        satsOn: false,
        sats: null,
        gnssCalls: 0,
        scrOff: 0,
        scrOffMs: 0,
        scrOffAt: 0,
        lastTick: now,
        maxGapMs: 0,
        keyLog: [],
        stopKey: null,
        keepOn: true,
        gpsOn: GPS_DEFAULT_ON,
        bytes: 0,
        cleaned: false,
        exitTimer: null,
        timers: [],
        shown: {}
      })
      this.vib = null
      this.recorder = null
      this.geo = null
      this.screen = null
      try { s.keepOn = localStorage.getItem('keepOn', '1') !== '0' } catch (e) {}
      try { s.gpsOn = localStorage.getItem('gpsOn', GPS_DEFAULT_ON ? '1' : '0') !== '0' } catch (e) {}
      try { s.satsOn = s.gpsOn && localStorage.getItem('satsOn', '0') === '1' } catch (e) {}
      blog('=== launch v' + VERSION + ' keepOn=' + s.keepOn + ' gps=' + s.gpsOn + ' sats=' + s.satsOn)
      try { this.vib = new Vibrator() } catch (e) { blog('vibrator err ' + e) }
      ensureDir()

      this.drawUi()
      try {
        onKey({
          callback: (key, ev) => {
            try { return this.onKeyEvent(key, ev) } catch (e) { blog('key err ' + e); return false }
          }
        })
      } catch (e) { blog('onKey err ' + e) }
      this.tick = setInterval(() => {
        try { this.onTick() } catch (e) { blog('tick err ' + e) }
      }, 1000)
      this.later(() => this.beginRecording(), PRESTART_MS)
    },

    // ---------------------------------------------------------------- UI
    drawUi() {
      const W = 480
      const t = (y, h, size, color, text, wrap) => {
        const o = {
          x: px(40), y: px(y), w: px(W - 80), h: px(h), color, text_size: px(size),
          align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V, text
        }
        if (wrap) o.text_style = hmUI.text_style.WRAP
        return hmUI.createWidget(hmUI.widget.TEXT, o)
      }
      // prestart: "MEMO" / "recording in 2 s" / [SEND]; afterwards the button
      // is hidden and timer / state / GPS / hint take over.
      this.wTimer = t(140, 110, 104, WHITE, 'MEMO')
      this.wState = t(250, 56, 40, WHITE, 'recording in 2 s')
      this.wGps = t(310, 48, 32, GREY, '')
      this.wHint = t(360, 80, 28, WHITE, '', true)
      this.wSendBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(110), y: px(330), w: px(260), h: px(90), radius: px(45),
        normal_color: 0x1f5fbf, press_color: 0x0f3f8f, color: WHITE, text_size: px(40),
        text: 'SEND', click_func: () => { if (this.s.phase === 'prestart') { blog('tap SEND in prestart'); this.goToSend() } }
      })
    },

    // Only touches a widget when its text actually changes.
    show(key, w, text) {
      if (this.s.shown[key] === text) return
      this.s.shown[key] = text
      try { w.setProperty(hmUI.prop.MORE, { text }) } catch (e) {}
    },

    gpsLine() {
      const s = this.s
      if (!s.gpsOn) return 'GPS: off'
      if (s.fix) return 'GPS: found (' + Math.round(s.fixMs / 1000) + ' s)' + (s.sats !== null ? ' ' + s.sats + ' sats' : '')
      return 'GPS: searching ' + Math.round((Date.now() - s.recStarted) / 1000) + ' s'
    },

    buzz(mode) {
      if (!this.vib) return
      try { this.vib.stop() } catch (e) {}
      try { this.vib.setMode(mode); this.vib.start() } catch (e) {}
    },

    later(fn, ms) {
      const t = setTimeout(() => {
        try { fn() } catch (e) { blog('timer err ' + e) }
      }, ms)
      this.s.timers.push(t)
      return t
    },

    // The single place where time-based UI and phase changes happen.
    onTick() {
      const s = this.s
      const now = Date.now()
      const gap = now - s.lastTick
      if (gap > s.maxGapMs) s.maxGapMs = gap
      s.lastTick = now
      if (s.phase === 'recording') {
        const ms = now - s.recStarted
        this.show('timer', this.wTimer, fmtDur(ms))
        this.show('gps', this.wGps, this.gpsLine())
        if (ms >= MAX_RECORD_MS) {
          s.stopKey = 'auto (max length)'
          this.stopRecording()
        }
      } else if (s.phase === 'gps') {
        const waited = now - s.recStopped
        this.show('timer', this.wTimer, Math.round(waited / 1000) + ' s')
        this.show('gps', this.wGps, this.gpsLine())
        if (s.fix) this.finish(true)
        else if (waited >= GPS_WAIT_AFTER_STOP_MS) this.finish(false, 'no fix after ' + Math.round(GPS_WAIT_AFTER_STOP_MS / 1000) + ' s')
        else if (Math.round(waited / 1000) % 15 === 0) blog('waiting ' + Math.round(waited / 1000) + 's changes=' + s.geoChanges)
      }
    },

    // ------------------------------------------------------------ keys
    // Single clicks only. Long presses are never handled (they belong to the
    // watch's own shortcuts), so they are passed straight back to the system.
    onKeyEvent(key, ev) {
      const s = this.s
      if (key === KEY_BACK) {
        // Never swallow BACK: stop everything and let the system leave the app.
        try { if (ev === KEY_EVENT_CLICK) this.cleanup('BACK') } catch (e) {}
        return false
      }
      if (ev !== KEY_EVENT_CLICK) return false
      const name = KEYNAME[key] || 'key' + key
      if (s.keyLog.length < 12) s.keyLog.push(name)
      if (key !== KEY_UP && key !== KEY_SELECT && key !== KEY_DOWN) return false
      if (Date.now() - s.t0 < KEY_GUARD_MS) return true
      if (s.phase === 'prestart') {
        blog('click ' + name + ' in prestart -> Send page')
        this.goToSend()
      } else if (s.phase === 'recording') {
        s.stopKey = name + ' click'
        this.later(() => this.stopRecording(), 0) // leave the key callback first
      } else if (s.phase === 'gps' && key === KEY_UP) {
        blog('click UP -> give up GPS')
        this.later(() => this.finish(false, 'gave up waiting (UP)'), 0)
      }
      return true
    },

    goToSend() {
      const s = this.s
      s.phase = 'menu'
      this.cleanup('to menu') // nothing should be running yet; make sure
      this.later(() => replace({ url: 'page/menu' }), 100)
    },

    // ------------------------------------------------------- recording
    beginRecording() {
      const s = this.s
      if (s.phase !== 'prestart') return
      s.id = Date.now()
      try { this.wSendBtn.setProperty(hmUI.prop.VISIBLE, false) } catch (e) {}
      if (s.keepOn) {
        try { setPageBrightTime({ brightTime: 2147483000 }) } catch (e) {}
        try { pauseDropWristScreenOff({ duration: 0 }) } catch (e) {}
      }
      this.show('hint', this.wHint, '')
      try {
        this.recorder = create(mediaId.RECORDER)
        this.recorder.setFormat(codec.OPUS, { target_file: recorderTarget(s.id) })
        this.recorder.start()
        s.recStarted = Date.now()
        s.phase = 'recording'
        blog('rec start id=' + s.id)
      } catch (e) {
        blog('rec start FAILED ' + e)
        this.recorder = null
        s.phase = 'failed'
        this.show('state', this.wState, 'MIC FAILED')
        this.show('hint', this.wHint, String(e).slice(0, 50))
        this.buzz(VIBRATOR_SCENE_DURATION_LONG)
        this.scheduleExit(6000)
        return
      }
      this.buzz(VIBRATOR_SCENE_DURATION)
      this.show('state', this.wState, 'RECORDING')
      this.show('timer', this.wTimer, '0:00')
      this.show('hint', this.wHint, 'press any button to stop')
      this.startScreenWatch()
      if (s.gpsOn) this.startGps()
      this.show('gps', this.wGps, this.gpsLine())
    },

    stopRecording() {
      const s = this.s
      if (s.phase !== 'recording') return
      s.phase = 'stopping'
      blog('stop pressed (' + s.stopKey + ')')
      this.stopRecorderOnce()
      this.buzz(VIBRATOR_SCENE_NOTIFICATION)
      this.show('state', this.wState, 'SAVING')
      this.show('hint', this.wHint, '')
      this.writeMeta('fix pending') // the memo exists from this moment on
      this.later(() => this.checkSaved(false), STAT_DELAY_MS)
    },

    stopRecorderOnce() {
      const s = this.s
      if (!this.recorder || s.recStopDone) return
      s.recStopDone = true
      s.recStopped = Date.now()
      try {
        this.recorder.stop()
        blog('rec stopped after ' + (s.recStopped - s.recStarted) + 'ms')
      } catch (e) {
        blog('rec stop err ' + e)
      }
      this.recorder = null
    },

    checkSaved(retry) {
      const s = this.s
      if (s.phase !== 'stopping') return
      s.bytes = audioSize(s.id)
      blog('file size ' + s.bytes + (retry ? ' (retry)' : ''))
      if (s.bytes === 0 && !retry) {
        this.later(() => this.checkSaved(true), STAT_RETRY_MS)
        return
      }
      if (s.bytes === 0) {
        s.phase = 'failed'
        this.writeMeta('recording file empty')
        this.cleanup('empty file')
        this.show('state', this.wState, 'NOT SAVED')
        this.show('hint', this.wHint, 'recording file empty')
        this.buzz(VIBRATOR_SCENE_DURATION_LONG)
        this.scheduleExit(6000)
        return
      }
      this.writeMeta(s.fix || !s.gpsOn ? undefined : 'fix pending')
      if (s.fix || !s.gpsOn) return this.finish(s.fix, s.gpsOn ? undefined : 'GPS off (safe mode)')
      s.phase = 'gps'
      blog('waiting for GPS')
      this.show('state', this.wState, 'WAITING FOR GPS')
      this.show('timer', this.wTimer, '0 s')
      this.show('hint', this.wHint, 'memo saved. press UP to skip GPS')
    },

    // ------------------------------------------------------------ GPS
    startGps() {
      const s = this.s
      if (this.geo) return
      try {
        this.geo = new Geolocation()
        this.geoCb = () => this.onGeoChange()
        this.geo.start()
        this.geo.onChange(this.geoCb)
        s.geoStopped = false
        blog('geo started')
        if (s.satsOn) {
          try {
            this.gnssCb = (info) => this.onGnss(info)
            this.geo.onGnssChange(this.gnssCb)
            blog('gnss listening')
          } catch (e) {
            this.gnssCb = null
            blog('gnss err ' + e)
          }
        }
      } catch (e) {
        blog('geo start FAILED ' + e)
        s.geoErr = String(e)
        this.stopGpsOnce()
      }
    },

    // Runs inside the native callback: copy values only, never stop or exit here.
    onGeoChange() {
      const s = this.s
      s.geoChanges++
      if (s.fix || s.geoStopped || !this.geo) return
      try {
        if (this.geo.getStatus() !== 'A') {
          if (s.geoChanges <= 3) blog('geo change ' + s.geoChanges + ' no fix')
          return
        }
        const lat = this.geo.getLatitude()
        const lon = this.geo.getLongitude()
        if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return
        s.lat = lat
        s.lon = lon
        s.fixMs = Date.now() - s.recStarted
        s.fix = true
        blog('fix ' + lat.toFixed(5) + ',' + lon.toFixed(5) + ' after ' + Math.round(s.fixMs / 1000) + 's')
      } catch (e) {
        if (s.geoChanges <= 3) blog('geo read err ' + e)
      }
    },

    // Native callback: copy one number, nothing else.
    onGnss(info) {
      const s = this.s
      s.gnssCalls++
      if (s.geoStopped) return
      const n = info && info.nb_used_satellite
      if (typeof n === 'number' && isFinite(n) && n >= 0 && n < 200) s.sats = n
      if (s.gnssCalls === 1) blog('gnss first: used=' + (info ? info.nb_used_satellite : 'none') + ' valid=' + (info ? info.nb_valid_satellite : 'none'))
    },

    stopGpsOnce() {
      const s = this.s
      if (!this.geo) return
      const g = this.geo
      this.geo = null
      s.geoStopped = true
      try { if (this.gnssCb) g.offGnssChange(this.gnssCb) } catch (e) {}
      this.gnssCb = null
      try { if (this.geoCb) g.offChange(this.geoCb) } catch (e) {}
      try { g.stop() } catch (e) {}
      blog('geo stopped (changes=' + s.geoChanges + (s.satsOn ? ' gnss=' + s.gnssCalls + ' sats=' + s.sats : '') + ')')
    },

    // ------------------------------------------------- screen-off watch
    startScreenWatch() {
      const s = this.s
      try {
        this.screen = new Screen()
        this.scrCb = () => {
          let st = 0
          try { st = this.screen ? this.screen.getStatus() : 0 } catch (e) {}
          if (st === 2 && !s.scrOffAt) {
            s.scrOff++
            s.scrOffAt = Date.now()
          } else if (st === 1 && s.scrOffAt) {
            s.scrOffMs += Date.now() - s.scrOffAt
            s.scrOffAt = 0
          }
        }
        this.screen.onChange(this.scrCb)
      } catch (e) {
        this.screen = null
      }
    },

    // ---------------------------------------------------------- memo file
    writeMeta(note) {
      const s = this.s
      if (!s.id) return null
      if (s.scrOffAt) {
        s.scrOffMs += Date.now() - s.scrOffAt
        s.scrOffAt = 0
      }
      const now = Date.now()
      const memo = {
        id: s.id,
        t: s.recStarted || s.id,
        tz: -new Date(s.id).getTimezoneOffset(),
        recMs: (s.recStopped || now) - (s.recStarted || now),
        bytes: s.bytes,
        fix: s.fix,
        lat: s.lat,
        lon: s.lon,
        fixS: s.fix ? Math.round(s.fixMs / 100) / 10 : null,
        sats: s.fix && s.sats !== null ? s.sats : undefined,
        gpsWaitS: s.recStopped ? Math.round((now - s.recStopped) / 1000) : null,
        scrOff: s.scrOff,
        scrOffMs: s.scrOffMs,
        maxGapMs: s.maxGapMs,
        keepOn: s.keepOn,
        stopKey: s.stopKey,
        keys: s.keyLog.join(', '),
        note: note || s.note || (s.geoErr ? 'gps: ' + s.geoErr : undefined),
        v: VERSION,
        sent: false
      }
      try {
        saveMeta(memo)
      } catch (e) {
        blog('meta write err ' + e)
      }
      return memo
    },

    finish(gotFix, why) {
      const s = this.s
      if (s.phase === 'done') return
      s.phase = 'done'
      if (!gotFix) s.note = why || 'no fix'
      this.writeMeta()
      blog('finish fix=' + gotFix + (why ? ' (' + why + ')' : ''))
      this.cleanup('finish')
      if (gotFix) {
        this.buzz(VIBRATOR_SCENE_STRONG_REMINDER)
        this.show('state', this.wState, 'SAVED')
        this.show('gps', this.wGps, this.gpsLine())
      } else {
        this.buzz(VIBRATOR_SCENE_DURATION_LONG)
        this.show('state', this.wState, s.gpsOn ? 'SAVED, NO GPS' : 'SAVED')
        this.show('gps', this.wGps, why || '')
      }
      this.show('hint', this.wHint, 'closing')
      this.scheduleExit(EXIT_DELAY_MS)
    },

    scheduleExit(ms) {
      if (this.s.exitTimer) return
      this.s.exitTimer = this.later(() => {
        this.cleanup('exit')
        blog('exit')
        exit()
      }, ms)
    },

    // Stops everything native. Safe to call any number of times.
    cleanup(why) {
      const s = this.s
      this.stopRecorderOnce()
      this.stopGpsOnce()
      if (this.screen) {
        try { this.screen.offChange(this.scrCb) } catch (e) {}
        this.screen = null
      }
      if (s.cleaned) return
      s.cleaned = true
      try { clearInterval(this.tick) } catch (e) {}
      try { offKey() } catch (e) {}
      try { resetDropWristScreenOff() } catch (e) {}
      try { resetPageBrightTime() } catch (e) {}
      blog('cleanup (' + why + ')')
    },

    onDestroy() {
      const s = this.s
      if (!s) return
      blog('destroy phase=' + s.phase)
      if (s.phase === 'recording' || s.phase === 'stopping' || s.phase === 'gps') {
        this.stopRecorderOnce()
        s.stopKey = s.stopKey || 'app closed (BACK?)'
        s.note = 'app closed during ' + s.phase
        this.writeMeta()
      }
      this.cleanup('destroy')
      s.timers.forEach((t) => { try { clearTimeout(t) } catch (e) {} })
      s.timers = []
      if (this.vib) { try { this.vib.stop() } catch (e) {} }
    }
  })
)
