import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  characterBottoms,
  characterModels,
  characterShoes,
  characterTops,
  floorIds,
  journalMaxNoteLength,
  journalMaxPhotosPerEntry,
  journalMaxPhotosPerGuest,
} from '../src/shared.ts'
import type {
  AdminLayout,
  CharacterOutfit,
  FloorId,
  GuestProfile,
  JournalEntry,
  JournalPhoto,
  JournalPhotoMime,
  JournalState,
  JournalSummary,
  Layout,
  TableCharacter,
  TableLayout,
} from '../src/shared.ts'
import { createJournalPhotoStore } from './journalPhotos.ts'
import type { DecodedPhoto } from './journalPhotos.ts'

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

    const floor = table.floor === undefined ? 1 : table.floor
    if (floor !== 1 && floor !== 2) {
      throw new AppError(400, 'Tầng của bàn không hợp lệ.')
    }
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
      floor,
      shape,
      x: coordinate(table.x, 0, 100),
      y: coordinate(table.y, 0, 100),
      rotation,
      chairs,
    }
  })
}

function initialFloor1Tables(): TableLayout[] {
  const columns = [26, 51.5, 77]
  const rows = [30, 44.7, 60.2, 75.4]
  const roundTables = new Set([1, 3, 5, 7, 11, 12])
  return rows.flatMap((y, row) => columns.map((x, column) => {
    const number = row * columns.length + column + 1
    const label = String(number).padStart(2, '0')
    return {
      id: `table-${label}`,
      label,
      floor: 1 as FloorId,
      shape: roundTables.has(number) ? 'round' : 'square',
      x,
      y,
      rotation: 0,
      chairs: [{ id: 'top', x: 0, y: -4.8 }, { id: 'bottom', x: 0, y: 4.8 }],
    }
  }))
}

function initialFloor2Tables(): TableLayout[] {
  const spots: { label: string; shape: 'round' | 'square'; x: number; y: number }[] = [
    { label: '201', shape: 'round', x: 30, y: 33 },
    { label: '202', shape: 'square', x: 49.5, y: 33 },
    { label: '203', shape: 'square', x: 30, y: 48.5 },
    { label: '204', shape: 'round', x: 53, y: 48.5 },
    { label: '205', shape: 'square', x: 75, y: 48.5 },
    { label: '206', shape: 'round', x: 30, y: 64.5 },
    { label: '207', shape: 'square', x: 53, y: 64.5 },
    { label: '208', shape: 'round', x: 75, y: 64.5 },
  ]
  return spots.map(({ label, shape, x, y }) => ({
    id: `table-${label}`,
    label,
    floor: 2 as FloorId,
    shape,
    x,
    y,
    rotation: 0,
    chairs: [{ id: 'top', x: 0, y: -4.8 }, { id: 'bottom', x: 0, y: 4.8 }],
  }))
}

function initialTables(): TableLayout[] {
  return [...initialFloor1Tables(), ...initialFloor2Tables()]
}

function normalizeFloor(value: unknown): FloorId {
  return (floorIds as readonly unknown[]).includes(value) ? (value as FloorId) : 1
}

const visitDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })

type StoredJournalEntry = {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string | null
  tableId: string | null
  tableLabel: string | null
  floor: number | null
  favorite: number
}

type StoredJournalPhoto = {
  id: string
  entryId: string
  guestId: string
  fileName: string
  mime: JournalPhotoMime
  width: number
  height: number
  sizeBytes: number
  position: number
  favorite: number
  createdAt: string
}

export function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const photoStore = createJournalPhotoStore(filename)
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
    CREATE TABLE IF NOT EXISTS journal_photos (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      position INTEGER NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS journal_photos_by_entry ON journal_photos (entry_id, position ASC);
    CREATE INDEX IF NOT EXISTS journal_photos_by_guest ON journal_photos (guest_id, created_at DESC);
  `)

  const journalColumns = new Set(
    (db.prepare('PRAGMA table_info(journal_entries)').all() as { name: string }[]).map((column) => column.name),
  )
  if (!journalColumns.has('table_id')) db.exec('ALTER TABLE journal_entries ADD COLUMN table_id TEXT')
  if (!journalColumns.has('table_label')) db.exec('ALTER TABLE journal_entries ADD COLUMN table_label TEXT')
  if (!journalColumns.has('floor')) db.exec('ALTER TABLE journal_entries ADD COLUMN floor INTEGER')
  if (!journalColumns.has('favorite')) db.exec('ALTER TABLE journal_entries ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0')
  if (!journalColumns.has('updated_at')) db.exec('ALTER TABLE journal_entries ADD COLUMN updated_at TEXT')

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
    SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt,
      table_id AS tableId, table_label AS tableLabel, floor, favorite
    FROM journal_entries
    WHERE guest_id = ? ORDER BY created_at DESC, rowid DESC
  `)
  const findJournalEntry = db.prepare(`
    SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt,
      table_id AS tableId, table_label AS tableLabel, floor, favorite
    FROM journal_entries
    WHERE id = ? AND guest_id = ?
  `)
  const addJournal = db.prepare(`
    INSERT INTO journal_entries (id, guest_id, title, body, created_at, updated_at, table_id, table_label, floor, favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateJournalEntryNote = db.prepare(`
    UPDATE journal_entries SET body = ?, updated_at = ? WHERE id = ? AND guest_id = ?
  `)
  const updateJournalEntryFavorite = db.prepare(`
    UPDATE journal_entries SET favorite = ? WHERE id = ? AND guest_id = ?
  `)
  const deleteJournalEntryRow = db.prepare('DELETE FROM journal_entries WHERE id = ? AND guest_id = ?')

  const listJournalPhotosByGuest = db.prepare(`
    SELECT id, entry_id AS entryId, guest_id AS guestId, file_name AS fileName,
      mime, width, height, size_bytes AS sizeBytes, position, favorite, created_at AS createdAt
    FROM journal_photos
    WHERE guest_id = ? ORDER BY created_at DESC, position ASC
  `)
  const listJournalPhotosByEntry = db.prepare(`
    SELECT id, entry_id AS entryId, guest_id AS guestId, file_name AS fileName,
      mime, width, height, size_bytes AS sizeBytes, position, favorite, created_at AS createdAt
    FROM journal_photos
    WHERE entry_id = ? AND guest_id = ? ORDER BY position ASC
  `)
  const countJournalPhotosByGuest = db.prepare('SELECT COUNT(*) AS total FROM journal_photos WHERE guest_id = ?')
  const findJournalPhotoRow = db.prepare(`
    SELECT id, entry_id AS entryId, guest_id AS guestId, file_name AS fileName,
      mime, width, height, size_bytes AS sizeBytes, position, favorite, created_at AS createdAt
    FROM journal_photos
    WHERE id = ? AND guest_id = ?
  `)
  const addJournalPhoto = db.prepare(`
    INSERT INTO journal_photos (id, entry_id, guest_id, file_name, mime, width, height, size_bytes, position, favorite, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const toggleJournalPhotoFav = db.prepare(`
    UPDATE journal_photos SET favorite = CASE WHEN favorite = 1 THEN 0 ELSE 1 END
    WHERE id = ? AND guest_id = ?
  `)
  const deleteJournalPhotoRow = db.prepare('DELETE FROM journal_photos WHERE id = ? AND guest_id = ?')

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
    const existingPublished = readLayout.get('published') as StoredLayout | undefined
    if (!existingPublished) {
      const tables = initialTables()
      const contents = JSON.stringify(tables)
      writeLayout.run('draft', 1, contents)
      writeLayout.run('published', 1, contents)
      createCodes(tables)
      return
    }
    const existingDraft = readLayout.get('draft') as StoredLayout | undefined
    const rawPublished = JSON.parse(existingPublished.tables) as Partial<TableLayout>[]
    const rawDraft = existingDraft ? (JSON.parse(existingDraft.tables) as Partial<TableLayout>[]) : rawPublished
    const hasFloorField = rawPublished.some((table) => 'floor' in table) || rawDraft.some((table) => 'floor' in table)
    if (hasFloorField) return

    // Backward-compatible one-time upgrade for existing databases created before Floor 2:
    // tag existing tables as floor 1 and append starter Floor 2 tables without overwriting existing data.
    const floor2 = initialFloor2Tables()
    const appendFloor2 = (existing: Partial<TableLayout>[]): TableLayout[] => {
      const normalized = existing.map((table) => ({ ...table, floor: normalizeFloor(table.floor) }) as TableLayout)
      const usedIds = new Set(normalized.map((table) => table.id))
      const usedLabels = new Set(normalized.map((table) => table.label.trim().toLocaleLowerCase('vi')))
      const additions = floor2.filter((table) =>
        !usedIds.has(table.id) && !usedLabels.has(table.label.toLocaleLowerCase('vi')),
      )
      return [...normalized, ...additions].slice(0, 80)
    }
    const nextPublished = appendFloor2(rawPublished)
    const nextDraft = appendFloor2(rawDraft)
    writeLayout.run('published', existingPublished.version, JSON.stringify(nextPublished))
    writeLayout.run('draft', existingDraft?.version ?? existingPublished.version, JSON.stringify(nextDraft))
    createCodes([...nextPublished, ...nextDraft])
  })

  function read(slot: 'draft' | 'published'): Layout {
    const stored = readLayout.get(slot) as StoredLayout
    const tables = (JSON.parse(stored.tables) as Partial<TableLayout>[]).map((table) => ({
      ...table,
      floor: normalizeFloor(table.floor),
    }) as TableLayout)
    return { version: stored.version, tables }
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

  function formatPhoto(row: StoredJournalPhoto): JournalPhoto {
    return {
      id: row.id,
      url: `/api/journal/photos/${row.id}`,
      downloadUrl: `/api/journal/photos/${row.id}?download=1`,
      mime: row.mime,
      width: row.width,
      height: row.height,
      favorite: row.favorite === 1,
      createdAt: row.createdAt,
    }
  }

  function formatEntry(row: StoredJournalEntry, photos: JournalPhoto[]): JournalEntry {
    const floor = row.floor === 1 || row.floor === 2 ? (row.floor as FloorId) : null
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      tableId: row.tableId,
      tableLabel: row.tableLabel,
      floor,
      favorite: row.favorite === 1 || photos.some((photo) => photo.favorite),
      photos,
    }
  }

  function buildJournalState(guestId: string): JournalState {
    const entryRows = listJournal.all(guestId) as StoredJournalEntry[]
    const photoRows = listJournalPhotosByGuest.all(guestId) as StoredJournalPhoto[]
    const photosByEntry = new Map<string, JournalPhoto[]>()
    for (const photoRow of photoRows) {
      const group = photosByEntry.get(photoRow.entryId) ?? []
      group.push(formatPhoto(photoRow))
      photosByEntry.set(photoRow.entryId, group)
    }
    const visitDays = new Set<string>()
    let totalPhotos = 0
    const entries = entryRows.map((row) => {
      const photos = photosByEntry.get(row.id) ?? []
      totalPhotos += photos.length
      visitDays.add(visitDayFormat.format(new Date(row.createdAt)))
      return formatEntry(row, photos)
    })
    const summary: JournalSummary = {
      totalPhotos,
      totalEntries: entries.length,
      visitCount: visitDays.size,
    }
    return { entries, summary }
  }

  return {
    close: () => {
      db.close()
      photoStore.cleanup()
    },
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
    journal(guestId: string): JournalState {
      return buildJournalState(guestId)
    },
    writeJournal(
      guestId: string,
      title: string,
      body: string,
      seat?: { tableId: string; tableLabel: string; floor: FloorId } | null,
    ): { entry: JournalEntry; summary: JournalSummary } {
      const createdAt = new Date().toISOString()
      const id = randomUUID()
      addJournal.run(
        id,
        guestId,
        title,
        body,
        createdAt,
        null,
        seat?.tableId ?? null,
        seat?.tableLabel ?? null,
        seat?.floor ?? null,
        0,
      )
      const state = buildJournalState(guestId)
      const entry = state.entries.find((item) => item.id === id)
      if (!entry) throw new Error('Không tìm thấy nhật ký vừa lưu.')
      return { entry, summary: state.summary }
    },
    createJournalPhotoEntry(
      guestId: string,
      note: string,
      photos: DecodedPhoto[],
      seat?: { tableId: string; tableLabel: string; floor: FloorId } | null,
    ): { entry: JournalEntry; summary: JournalSummary } {
      if (photos.length < 1 || photos.length > journalMaxPhotosPerEntry) {
        throw new AppError(400, `Hãy chọn từ 1 đến ${journalMaxPhotosPerEntry} ảnh mỗi lần lưu.`)
      }
      if ([...note].length > journalMaxNoteLength) {
        throw new AppError(400, `Ghi chú ngắn tối đa ${journalMaxNoteLength} ký tự.`)
      }
      const existing = Number((countJournalPhotosByGuest.get(guestId) as { total: number } | undefined)?.total ?? 0)
      if (existing + photos.length > journalMaxPhotosPerGuest) {
        throw new AppError(409, `Album cá nhân lưu tối đa ${journalMaxPhotosPerGuest} ảnh. Hãy xóa bớt ảnh cũ trước khi lưu thêm.`)
      }

      const createdAt = new Date().toISOString()
      const entryId = randomUUID()
      const prepared = photos.map((photo, position) => ({
        id: randomUUID(),
        position,
        photo,
      }))
      const writtenFiles: string[] = []
      try {
        const storedFiles = prepared.map((item) => {
          const fileName = photoStore.write(guestId, item.id, item.photo.ext, item.photo.buffer)
          writtenFiles.push(fileName)
          return { ...item, fileName }
        })
        transaction(() => {
          const recheck = Number((countJournalPhotosByGuest.get(guestId) as { total: number } | undefined)?.total ?? 0)
          if (recheck + storedFiles.length > journalMaxPhotosPerGuest) {
            throw new AppError(409, `Album cá nhân lưu tối đa ${journalMaxPhotosPerGuest} ảnh.`)
          }
          addJournal.run(
            entryId,
            guestId,
            '',
            note,
            createdAt,
            null,
            seat?.tableId ?? null,
            seat?.tableLabel ?? null,
            seat?.floor ?? null,
            0,
          )
          for (const item of storedFiles) {
            addJournalPhoto.run(
              item.id,
              entryId,
              guestId,
              item.fileName,
              item.photo.mime,
              item.photo.width,
              item.photo.height,
              item.photo.buffer.length,
              item.position,
              0,
              createdAt,
            )
          }
        })
      } catch (error) {
        photoStore.remove(writtenFiles)
        throw error
      }

      const state = buildJournalState(guestId)
      const entry = state.entries.find((item) => item.id === entryId)
      if (!entry) throw new Error('Không tìm thấy nhật ký vừa lưu.')
      return { entry, summary: state.summary }
    },
    readJournalPhoto(guestId: string, photoId: string): { id: string; mime: JournalPhotoMime; createdAt: string; buffer: Buffer } | null {
      const row = findJournalPhotoRow.get(photoId, guestId) as StoredJournalPhoto | undefined
      if (!row) return null
      const buffer = photoStore.read(row.fileName)
      if (!buffer) return null
      return { id: row.id, mime: row.mime, createdAt: row.createdAt, buffer }
    },
    updateJournalNote(guestId: string, entryId: string, note: string): JournalState {
      const existing = findJournalEntry.get(entryId, guestId) as StoredJournalEntry | undefined
      if (!existing) throw new AppError(404, 'Không tìm thấy kỷ niệm này.')
      const limit = existing.title ? 4000 : journalMaxNoteLength
      if ([...note].length > limit) {
        throw new AppError(400, `Ghi chú tối đa ${limit} ký tự.`)
      }
      updateJournalEntryNote.run(note, new Date().toISOString(), entryId, guestId)
      return buildJournalState(guestId)
    },
    toggleJournalPhotoFavorite(guestId: string, photoId: string): JournalState {
      const photo = findJournalPhotoRow.get(photoId, guestId) as StoredJournalPhoto | undefined
      if (!photo) throw new AppError(404, 'Không tìm thấy ảnh này.')
      transaction(() => {
        toggleJournalPhotoFav.run(photoId, guestId)
        const siblings = listJournalPhotosByEntry.all(photo.entryId, guestId) as StoredJournalPhoto[]
        const anyFav = siblings.some((item) => item.favorite === 1) ? 1 : 0
        updateJournalEntryFavorite.run(anyFav, photo.entryId, guestId)
      })
      return buildJournalState(guestId)
    },
    deleteJournalPhoto(guestId: string, photoId: string): JournalState {
      const photo = findJournalPhotoRow.get(photoId, guestId) as StoredJournalPhoto | undefined
      if (!photo) throw new AppError(404, 'Không tìm thấy ảnh này.')
      transaction(() => {
        deleteJournalPhotoRow.run(photoId, guestId)
        const remaining = listJournalPhotosByEntry.all(photo.entryId, guestId) as StoredJournalPhoto[]
        if (remaining.length === 0) {
          const entry = findJournalEntry.get(photo.entryId, guestId) as StoredJournalEntry | undefined
          if (entry && !entry.title.trim()) {
            deleteJournalEntryRow.run(photo.entryId, guestId)
          } else {
            updateJournalEntryFavorite.run(0, photo.entryId, guestId)
          }
        } else {
          const anyFav = remaining.some((item) => item.favorite === 1) ? 1 : 0
          updateJournalEntryFavorite.run(anyFav, photo.entryId, guestId)
        }
      })
      photoStore.remove([photo.fileName])
      return buildJournalState(guestId)
    },
    deleteJournalEntry(guestId: string, entryId: string): JournalState {
      const entry = findJournalEntry.get(entryId, guestId) as StoredJournalEntry | undefined
      if (!entry) throw new AppError(404, 'Không tìm thấy kỷ niệm này.')
      const photos = listJournalPhotosByEntry.all(entryId, guestId) as StoredJournalPhoto[]
      transaction(() => {
        deleteJournalEntryRow.run(entryId, guestId)
      })
      photoStore.remove(photos.map((item) => item.fileName))
      return buildJournalState(guestId)
    },
  }
}
