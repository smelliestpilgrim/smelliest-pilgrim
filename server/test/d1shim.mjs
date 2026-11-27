// Tiny in-memory stand-in for Cloudflare D1, on Node's built-in node:sqlite
// (no new dependency). Only what src/index.js uses: prepare().bind().first()
// / .all() / .run(), and batch() as one transaction.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export function makeDB(migrationsDir) {
  const db = new DatabaseSync(':memory:')
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
  const conv = (v) => (v instanceof Uint8Array && !(v instanceof Buffer) ? v : v)
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args }
    bind(...a) { return new Stmt(this.sql, a.map(conv)) }
    async first() { return this._first() }
    _first() { const r = db.prepare(this.sql).get(...this.args); return r === undefined ? null : { ...r } }
    async all() { return this._all() }
    _all() { return { results: db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true } }
    async run() { return this._run() }
    _run() { const r = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: r.changes } } }
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN')
      try { const out = stmts.map((s) => (/^\s*select/i.test(s.sql) ? s._all() : s._run())); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }
}
