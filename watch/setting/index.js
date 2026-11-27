// Smelliest Pilgrim settings page inside the Zepp phone app (Profile > device > App list > Smelliest Pilgrim).
// Picks where the watch's memos go. Values are plain strings in settingsStorage:
//   dest        'phone' (default) | 'server'
//   serverUrl   e.g. https://watchmemo.example.workers.dev
//   serverToken the server's secret token
//   testReq     bumped by "Test connection"; the Side Service answers in testResult
function v(props, k) {
  const s = props.settingsStorage.getItem(k)
  return s === undefined || s === null ? '' : String(s).replace(/^"(.*)"$/, '$1')
}

AppSettingsPage({
  build(props) {
    const dest = v(props, 'dest') === 'server' ? 'server' : 'phone'
    const url = v(props, 'serverUrl')
    const token = v(props, 'serverToken')
    const result = v(props, 'testResult')
    const set = (k, val) => props.settingsStorage.setItem(k, String(val == null ? '' : val).trim())
    const pad = (children, top) => View({ style: { marginTop: (top || 12) + 'px', padding: '0 12px' } }, children)

    const items = [
      pad([Text({ bold: true, paragraph: true }, ['Where your trail memos go'])], 16),
      pad([
        Select({
          label: 'Destination',
          title: 'Destination',
          value: dest,
          options: [
            { name: 'Smelliest Pilgrim phone app (this phone, offline)', value: 'phone' },
            { name: 'My server (internet)', value: 'server' }
          ],
          onChange: (val) => set('dest', Array.isArray(val) ? val[0] : val)
        })
      ]),
      pad([
        Text({ paragraph: true, style: { fontSize: '13px', color: '#666' } }, [
          dest === 'server'
            ? 'Memos are sent from this phone to the server below, over https, with your token. Nothing goes to the developer.'
            : 'Memos go only to the Smelliest Pilgrim app on this phone (127.0.0.1). Nothing leaves the phone. Open it before you press Send on the watch.'
        ])
      ])
    ]

    if (dest === 'server') {
      items.push(
        pad([TextInput({ label: 'Server URL', placeholder: 'https://your-server.example', value: url, onChange: (val) => set('serverUrl', val) })]),
        pad([TextInput({ label: 'Token', placeholder: 'the secret token of your server', value: token, onChange: (val) => set('serverToken', val) })])
      )
      if (url) {
        items.push(pad([Link({ source: url.replace(/\/+$/, '') + '/' }, [Text({}, ['Open my memos page'])])]))
      }
    }

    items.push(
      pad([
        Button({
          label: 'Test connection',
          color: 'primary',
          onClick: () => {
            set('testResult', 'testing...')
            set('testReq', Date.now())
          }
        })
      ], 18),
      pad([Text({ paragraph: true, style: { fontSize: '13px' } }, [result || 'Not tested yet. The watch must be connected.'])])
    )

    return Section({}, items)
  }
})
