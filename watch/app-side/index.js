// Runs inside the Zepp app on the phone. It only relays: each watch message
// becomes one HTTP call to the destination picked in the Memo settings page:
//   - "WatchMemo phone app" (default): http://127.0.0.1:8765 on this phone,
//     nothing leaves the phone (same as 0.1.4);
//   - "My server": the user's own https server, with a bearer token.
import { BaseSideService, settingsLib } from '@zeppos/zml/base-side'
import { handleRequest, destination } from '../utils/sidecore'

const get = (k) => settingsLib.getItem(k)

function runTest() {
  const cfg = destination(get)
  const d = new Date()
  const when = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes()
  handleRequest(fetch, { method: 'ping', params: {} }, (e, r) => {
    let line
    if (r && r.ok) line = 'OK: ' + (cfg.dest === 'server' ? 'server' : 'Smelliest Pilgrim phone app') + ' answered (' + (r.today || 0) + ' memos today)'
    else line = 'FAILED: ' + ((r && r.error) || e || 'no answer')
    try { settingsLib.setItem('testResult', line + ' at ' + when) } catch (x) {}
  }, cfg)
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRequest(req, res) {
      // Read the settings on every request so a change applies at once.
      handleRequest(fetch, req, res, destination(get))
    },
    onSettingsChange(ev) {
      if (ev && ev.key === 'testReq') runTest()
    },
    onRun() {},
    onDestroy() {}
  })
)
