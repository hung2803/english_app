// D1 giả dùng SQLite có sẵn trong Node (node:sqlite), áp dụng đúng các file trong migrations/.
// Chỉ dùng trong test.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

class Stmt {
  private args: unknown[] = []
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args
    return this
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]))
    return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }
  }
  /** Dùng trong batch: câu lệnh có RETURNING trả về các dòng (giống D1 thật), còn lại trả meta. */
  async exec() {
    if (/RETURNING/i.test(this.sql)) {
      const results = this.db.prepare(this.sql).all(...(this.args as never[]))
      return { success: true, results, meta: { changes: results.length } }
    }
    const r = await this.run()
    return { ...r, results: [] as Row[] }
  }
  async first<T = Row>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null
  }
  async all<T = Row>() {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[], success: true }
  }
}

export function createTestDb(): D1Database {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const dir = join(import.meta.dirname, '..', 'migrations')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'))
  }
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s.exec())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 1, duration: 0 }
    },
  } as unknown as D1Database
}
