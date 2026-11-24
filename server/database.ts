import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { characterBottoms, characterModels, characterShoes, characterTops } from '../src/shared.ts'
import type { AdminLayout, CharacterOutfit, GuestProfile, JournalEntry, Layout, TableCharacter, TableLayout } from '../src/shared.ts'

export class AppError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

type GuestSeat = { id: string; tableId: string; checkedInAt: number }
export type Guest = GuestSeat & { profile: TableCharacter | null }
type StoredCharacter = Omit<TableCharacter, 'id' | 'outfit'> & CharacterOutfit & { characterId: string }
type StoredGuest = GuestSeat & (StoredCharacter | { characterId: null })
type StoredLayout = { version: number; tables: string }

const guestLifetime = 12 * 60 * 60 * 1000
const idPattern = /^[a-z0-9_-]{1,64}$/i

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'Dữ liệu gửi lên không hợp lệ.')
  }
  return value as Record<string, unknown>
}

function includesOption<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
}

export function parseProfile(value: unknown): GuestProfile {
  const { displayName, model, outfit } = object(value)
  const name = typeof displayName === 'string' && displayName.length <= 192
    && !/[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(displayName) ? displayName.trim().normalize('NFC') : ''
  if (!name || [...name].length > 24) {
    throw new AppError(400, 'Tên hiển thị cần từ 1 đến 24 ký tự hợp lệ.')
  }
  if (!includesOption(characterModels, model)) {
    throw new AppError(400, 'Mẫu nhân vật không hợp lệ.')
  }
  const { top, bottom, shoes } = object(outfit)
  if (!includesOption(characterTops, top) || !includesOption(characterBottoms, bottom) || !includesOption(characterShoes, shoes)) {
    throw new AppError(400, 'Trang phục không hợp lệ.')
  }
  return { displayName: name, model, outfit: { top, bottom, shoes } }
}

function readCharacter(row: StoredCharacter): TableCharacter {
  return { id: row.characterId, displayName: row.displayName, model: row.model,
    outfit: { top: row.top, bottom: row.bottom, shoes: row.shoes } }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new AppError(400, 'Mã định danh bàn hoặc ghế không hợp lệ.')
  }
  return value
}

function coordinate(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AppError(400, 'Vị trí hoặc góc xoay bàn ghế không hợp lệ.')
  }
  return value
}

export function parseTables(value: unknown): TableLayout[] {
  if (!Array.isArray(value) || value.length > 80) {
    throw new AppError(400, 'Sơ đồ có thể chứa tối đa 80 bàn.')
  }

  const ids = new Set<string>()
  const labels = new Set<string>()
  return value.map((input) => {
    const table = object(input)
    const id = identifier(table.id)
    const label = typeof table.label === 'string' ? table.label.trim() : ''
    const labelKey = label.toLocaleLowerCase('vi')
    if (!label || label.length > 12) {
      throw new AppError(400, 'Số hoặc tên bàn cần có từ 1 đến 12 ký tự.')
    }
    if (ids.has(id) || labels.has(labelKey)) {
      throw new AppError(400, 'Số hoặc tên bàn phải khác nhau.')
    }
    ids.add(id)
    labels.add(labelKey)

    const shape = table.shape
    if (shape !== 'round' && shape !== 'square') {
      throw new AppError(400, 'Kiểu bàn không hợp lệ.')
    }
    if (!Array.isArray(table.chairs) || table.chairs.length > 12) {
      throw new AppError(400, 'Mỗi bàn được đặt tối đa 12 ghế.')
    }
    const chairIds = new Set<string>()
    const chairs = table.chairs.map((input) => {
      const chair = object(input)
      const chairId = identifier(chair.id)
      if (chairIds.has(chairId)) {
        throw new AppError(400, 'Mã ghế trong cùng một bàn phải khác nhau.')
      }
      chairIds.add(chairId)
      return { id: chairId, x: coordinate(chair.x, -100, 100), y: coordinate(chair.y, -100, 100) }
    })

    const rotation = coordinate(table.rotation, 0, 360)
    if (rotation === 360) throw new AppError(400, 'Góc xoay cần nhỏ hơn 360 độ.')
    return {
      id,
      label,
      shape,
      x: coordinate(table.x, 0, 100),
      y: coordinate(table.y, 0, 100),
      rotation,
      chairs,
    }
  })
}

function initialTables(): TableLayout[] {
  const columns = [26, 51.5, 77]
  const rows = [30, 44.7, 60.2, 75.4]
  const roundTables = new Set([1, 3, 5, 7, 11, 12])
  return rows.flatMap((y, row) => columns.map((x, column) => {
    const number = row * columns.length + column + 1
    const label = String(number).padStart(2, '0')
    return {
      id: `table-${label}`,
      label,
      shape: roundTables.has(number) ? 'round' : 'square',
      x,
      y,
      rotation: 0,
      chairs: [{ id: 'top', x: 0, y: -4.8 }, { id: 'bottom', x: 0, y: 4.8 }],
    }
  }))
}

export function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, timeout: 5000 })
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS layouts (
      slot TEXT PRIMARY KEY CHECK (slot IN ('draft', 'published')),
      version INTEGER NOT NULL,
      tables TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS table_codes (
      table_id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS guests (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      checked_in_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS guest_profiles (
      guest_id TEXT PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
      public_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      model TEXT NOT NULL,
      top TEXT NOT NULL,
      bottom TEXT NOT NULL,
      shoes TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS journal_by_guest ON journal_entries (guest_id, created_at DESC);
  `)

  const readLayout = db.prepare('SELECT version, tables FROM layouts WHERE slot = ?')
  const writeLayout = db.prepare(`
    INSERT INTO layouts (slot, version, tables) VALUES (?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET version = excluded.version, tables = excluded.tables
  `)
  const addCode = db.prepare('INSERT INTO table_codes (table_id, code) VALUES (?, ?) ON CONFLICT(table_id) DO NOTHING')
  const listCodes = db.prepare('SELECT table_id AS tableId, code FROM table_codes')
  const findCode = db.prepare('SELECT table_id AS tableId FROM table_codes WHERE code = ?')
  const findGuest = db.prepare(`
    SELECT g.id, g.table_id AS tableId, g.checked_in_at AS checkedInAt,
      p.public_id AS characterId, p.display_name AS displayName, p.model, p.top, p.bottom, p.shoes
    FROM guests g LEFT JOIN guest_profiles p ON p.guest_id = g.id WHERE g.id = ?
  `)
  const checkGuestIn = db.prepare(`
    INSERT INTO guests (id, table_id, checked_in_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET table_id = excluded.table_id, checked_in_at = excluded.checked_in_at
  `)
  const upsertProfile = db.prepare(`
    INSERT INTO guest_profiles (guest_id, public_id, display_name, model, top, bottom, shoes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guest_id) DO UPDATE SET display_name = excluded.display_name, model = excluded.model,
      top = excluded.top, bottom = excluded.bottom, shoes = excluded.shoes
    RETURNING public_id
  `)
  const listJournal = db.prepare(`
    SELECT id, title, body, created_at AS createdAt FROM journal_entries
    WHERE guest_id = ? ORDER BY created_at DESC, rowid DESC
  `)
  const addJournal = db.prepare('INSERT INTO journal_entries (id, guest_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function createCodes(tables: TableLayout[]): void {
    for (const table of tables) addCode.run(table.id, randomBytes(18).toString('base64url'))
  }

  transaction(() => {
    if (readLayout.get('published')) return
    const tables = initialTables()
    const contents = JSON.stringify(tables)
    writeLayout.run('draft', 1, contents)
    writeLayout.run('published', 1, contents)
    createCodes(tables)
  })

  function read(slot: 'draft' | 'published'): Layout {
    const stored = readLayout.get(slot) as StoredLayout
    return { version: stored.version, tables: JSON.parse(stored.tables) as TableLayout[] }
  }

  let published = read('published')
  let publishedIds = new Set(published.tables.map((table) => table.id))

  function adminLayout(): AdminLayout {
    const draft = read('draft')
    const visibleIds = new Set([...publishedIds, ...draft.tables.map((table) => table.id)])
    const qrs = Object.fromEntries(
      (listCodes.all() as { tableId: string; code: string }[])
        .filter(({ tableId }) => visibleIds.has(tableId))
        .map(({ tableId, code }) => [tableId, code]),
    )
    return { draft, published, qrs }
  }

  function checkVersion(version: unknown, draft: Layout): void {
    if (version !== draft.version) {
      throw new AppError(409, 'Sơ đồ đã được cập nhật. Hãy tải lại trước khi chỉnh sửa.')
    }
  }

  return {
    close: () => db.close(),
    published: () => published,
    adminLayout,
    saveDraft(tables: TableLayout[], version: unknown): AdminLayout {
      transaction(() => {
        const draft = read('draft')
        checkVersion(version, draft)
        writeLayout.run('draft', draft.version + 1, JSON.stringify(tables))
        createCodes(tables)
      })
      return adminLayout()
    },
    publish(version: unknown): AdminLayout {
      const next = transaction(() => {
        const draft = read('draft')
        checkVersion(version, draft)
        writeLayout.run('published', draft.version, JSON.stringify(draft.tables))
        return draft
      })
      published = next
      publishedIds = new Set(published.tables.map((table) => table.id))
      return adminLayout()
    },
    guest(token: string | undefined): Guest | null {
      if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null
      const row = findGuest.get(token) as StoredGuest | undefined
      if (!row) return null
      return { id: row.id, tableId: row.tableId, checkedInAt: row.checkedInAt,
        profile: row.characterId === null ? null : readCharacter(row) }
    },
    activeTable(guest: Guest | null, now = Date.now()): string | null {
      return guest && publishedIds.has(guest.tableId) && now - guest.checkedInAt < guestLifetime
        ? guest.tableId : null
    },
    checkIn(code: unknown, previousGuest: Guest | null): Guest {
      if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{24}$/.test(code)) {
        throw new AppError(404, 'Mã QR bàn không hợp lệ.')
      }
      const match = findCode.get(code) as { tableId: string } | undefined
      if (!match || !publishedIds.has(match.tableId)) {
        throw new AppError(404, 'Mã QR này không dẫn tới bàn đang mở.')
      }
      const id = previousGuest?.id ?? randomBytes(32).toString('base64url')
      const checkedInAt = Date.now()
      checkGuestIn.run(id, match.tableId, checkedInAt)
      return { id, tableId: match.tableId, checkedInAt, profile: previousGuest?.profile ?? null }
    },
    saveProfile(guestId: string, profile: GuestProfile): TableCharacter {
      const { displayName, model, outfit: { top, bottom, shoes } } = profile
      const result = upsertProfile.get(guestId, randomUUID(), displayName, model, top, bottom, shoes)
      if (typeof result?.public_id !== 'string') throw new Error('Không tìm thấy nhân vật vừa lưu.')
      return { ...profile, id: result.public_id }
    },
    journal(guestId: string): JournalEntry[] {
      return listJournal.all(guestId).map((entry) => ({
        id: String(entry.id),
        title: String(entry.title),
        body: String(entry.body),
        createdAt: String(entry.createdAt),
      }))
    },
    writeJournal(guestId: string, title: string, body: string): JournalEntry {
      const entry = { id: randomUUID(), title, body, createdAt: new Date().toISOString() }
      addJournal.run(entry.id, guestId, title, body, entry.createdAt)
      return entry
    },
  }
}
