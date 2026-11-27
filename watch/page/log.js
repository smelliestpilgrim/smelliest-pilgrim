// Breadcrumb log viewer: newest lines first, and a button to send it.
import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'
import { BasePage } from '@zeppos/zml/base-page'
import { setTimeout, clearTimeout } from '@zos/timer'
import { readLog, logBytes, blog } from '../utils/blog'
import { sendText } from '../utils/sender'
import { connectStatus } from '@zos/ble'

const LINES = 40

Page(
  BasePage({
    state: {},
    build() {
      blog('log page open')
      const lines = readLog().split('\n').filter((l) => l).reverse().slice(0, LINES)
      this.wBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(110), y: px(40), w: px(260), h: px(70), radius: px(35),
        normal_color: 0x1f5fbf, press_color: 0x0f3f8f, color: 0xffffff, text_size: px(30),
        text: 'SEND LOG', click_func: () => this.send()
      })
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(40), y: px(120), w: px(400), h: px(Math.max(340, lines.length * 64)),
        color: 0xffffff, text_size: px(24), text_style: hmUI.text_style.WRAP,
        align_h: hmUI.align.LEFT, align_v: hmUI.align.TOP,
        text: lines.length ? 'newest first, scroll down\n' + lines.join('\n') : 'log is empty'
      })
    },
    onDestroy() { this.dead = true },
    send() {
      if (this.busy) return
      this.busy = true
      this.wBtn.setProperty(hmUI.prop.MORE, { text: 'SENDING' })
      const io = {
        request: (d) => this.request(d), setTimeout, clearTimeout, now: () => Date.now(),
        linkUp: () => connectStatus(), log: (l) => blog(l), alive: () => !this.dead
      }
      sendText(io, logBytes(), null, (err) => {
        if (this.dead) return
        this.busy = false
        try { this.wBtn.setProperty(hmUI.prop.MORE, { text: err ? 'NOT SENT' : 'LOG SENT' }) } catch (e) {}
      }, (e) => {
        try { this.wBtn.setProperty(hmUI.prop.MORE, { text: 'RETRYING' }) } catch (x) {}
      })
    }
  })
)
