// Side Service request handling, with fetch injected so node can test it.
// zfetch is the Zepp Side Service fetch: zfetch({ url, method, headers, body })
// resolving to { status, body } where body may be a string or parsed JSON.
// 0.2.0: the destination comes from the Zepp app settings page (see
// destination()): the WatchMemo phone app on 127.0.0.1 (default, exactly the
// 0.1.4 behaviour) or the user's own server (https URL + bearer token). Both speak
// the same /ping /chunk /logpart /commit protocol.
import { BASE_URL } from './protocol'
import { formEncode } from './codec'

export const DEST_PHONE = 'phone'
export const DEST_SERVER = 'server'

// Settings values may arrive JSON-quoted ('"server"') depending on the
// component that wrote them; accept both.
function clean(v) {
  if (v === undefined || v === null) return ''
  let s = String(v).trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { s = String(JSON.parse(s)) } catch (e) {}
  }
  return s.trim()
}

// get(key) reads the Zepp settingsStorage. Returns
// { dest, base, token, error } ; error is set when 'My server' is chosen but
// unusable, so nothing is sent anywhere unexpected.
export function destination(get) {
  const g = (k) => { try { return clean(get(k)) } catch (e) { return '' } }
  const dest = g('dest') === DEST_SERVER ? DEST_SERVER : DEST_PHONE
  if (dest === DEST_PHONE) return { dest, base: BASE_URL, token: '' }
  let base = g('serverUrl').replace(/\/+$/, '')
  const token = g('serverToken')
  if (!base) return { dest, error: 'no server URL set (Zepp app > Smelliest Pilgrim > Settings)' }
  if (!/^https:\/\/[^\s/]+/i.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost|10\.|192\.168\.)/i.test(base)) {
    return { dest, error: 'server URL must start with https://' }
  }
  if (!token) return { dest, error: 'no server token set (Zepp app > Smelliest Pilgrim > Settings)' }
  return { dest, base, token }
}

function parse(body) {
  if (body && typeof body === 'object') return body
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch (e) {
      return { ok: false, error: 'bad reply: ' + body.slice(0, 80) }
    }
  }
  return { ok: false, error: 'empty reply' }
}

function describe(e, cfg) {
  const s = e && e.message ? e.message : String(e)
  if (cfg && cfg.dest === DEST_SERVER) return 'server not reachable (' + s + ')'
  return 'phone app not reachable (' + s + ')'
}

function call(zfetch, opts, res, cfg) {
  let p
  if (cfg && cfg.token) opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + cfg.token })
  try {
    p = zfetch(opts)
  } catch (e) {
    res(null, { ok: false, error: describe(e, cfg), dest: cfg && cfg.dest })
    return
  }
  p.then(
    (r) => {
      const status = r && typeof r.status === 'number' ? r.status : 0
      const data = parse(r && r.body)
      if (status < 200 || status >= 300) {
        let error = (data && data.error) || 'HTTP ' + status
        if (status === 401 && cfg && cfg.dest === DEST_SERVER) error = 'server refused the token (check app settings)'
        res(null, { ok: false, status, error, dest: cfg && cfg.dest })
        return
      }
      if (data && typeof data === 'object' && data.ok === undefined) data.ok = true
      if (data && typeof data === 'object' && cfg && cfg.dest) data.dest = cfg.dest
      res(null, data)
    },
    (e) => res(null, { ok: false, error: describe(e, cfg), dest: cfg && cfg.dest })
  )
}

// cfg: the result of destination(); omitted = the phone app (0.1.4 behaviour).
export function handleRequest(zfetch, req, res, cfg) {
  if (!cfg) cfg = { dest: DEST_PHONE, base: BASE_URL, token: '' }
  if (cfg.error) {
    // 400: the sender treats it as a real refusal and stops, instead of retrying for 3 min.
    res(null, { ok: false, status: 400, error: cfg.error, dest: cfg.dest })
    return
  }
  const BASE = cfg.base
  const m = req && req.method
  const p = (req && req.params) || {}
  if (m === 'ping') {
    call(zfetch, { url: BASE + '/ping', method: 'GET' }, res, cfg)
  } else if (m === 'chunk') {
    call(
      zfetch,
      {
        // 0.1.4: o = byte offset (only when the phone app said offsets:true)
        url: BASE + '/chunk?id=' + encodeURIComponent(p.id) + '&i=' + p.i + '&n=' + p.n + (typeof p.o === 'number' ? '&o=' + p.o : ''),
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: String(p.d || '')
      },
      res,
      cfg
    )
  } else if (m === 'logpart') {
    call(
      zfetch,
      {
        url: BASE + '/logpart?id=' + encodeURIComponent(p.id) + '&i=' + p.i + '&n=' + p.n,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: String(p.d || '')
      },
      res,
      cfg
    )
  } else if (m === 'commit') {
    call(
      zfetch,
      {
        url: BASE + '/commit',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode(p)
      },
      res,
      cfg
    )
  } else {
    res(null, { ok: false, error: 'unknown method ' + m })
  }
}
