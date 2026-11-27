// Renders setting/index.js with mocked Zepp Settings App components and checks
// the destination switch, the server fields and the test button.
import fs from 'node:fs'
import assert from 'node:assert/strict'
const src = fs.readFileSync(new URL('../setting/index.js', import.meta.url), 'utf8')
let page
const node = (type) => (props, kids) => ({ type, props: props || {}, kids: kids || [] })
const g = { AppSettingsPage: (p) => { page = p }, Section: node('Section'), View: node('View'), Text: node('Text'), Select: node('Select'), TextInput: node('TextInput'), Button: node('Button'), Link: node('Link') }
new Function(...Object.keys(g), src)(...Object.values(g))
const store = {}
const props = { settingsStorage: { getItem: (k) => store[k], setItem: (k, v) => { store[k] = v } } }
const flat = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); (n.kids || []).forEach((k) => flat(k, out)) } return out }
let tree = flat(page.build(props))
const sel = tree.find((n) => n.type === 'Select')
assert.equal(sel.props.value, 'phone'); assert.equal(tree.filter((n) => n.type === 'TextInput').length, 0)
console.log('  ok default: Smelliest Pilgrim phone app, no server fields')
sel.props.onChange('server')
tree = flat(page.build(props))
const inputs = tree.filter((n) => n.type === 'TextInput')
assert.equal(store.dest, 'server'); assert.equal(inputs.length, 2)
inputs[0].props.onChange(' https://watchmemo.example.workers.dev/ '); inputs[1].props.onChange('tok-123')
assert.equal(store.serverUrl, 'https://watchmemo.example.workers.dev/'); assert.equal(store.serverToken, 'tok-123')
tree = flat(page.build(props))
assert.equal(tree.find((n) => n.type === 'Link').props.source, 'https://watchmemo.example.workers.dev/')
console.log('  ok My server: URL + token saved (trimmed), memos-page link shown')
tree.find((n) => n.type === 'Button').props.onClick()
assert.equal(store.testResult, 'testing...'); assert.ok(Number(store.testReq) > 0)
console.log('  ok Test connection asks the Side Service (testReq) and shows "testing..."')
sel.props.onChange(['phone']); assert.equal(store.dest, 'phone')
console.log('SETTINGS PAGE PASS')
